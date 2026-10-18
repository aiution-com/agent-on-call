import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { pool, query } from './db';

const scrypt = promisify(scryptCallback);
const cookieName = 'aoc_session';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export interface Identity { id: string; org_id: string; email: string; name: string; workspace_name: string; mode: 'session' | 'key'; key_id?: string | null; }
export const identity = (res: Response): Identity => res.locals.identity;
export function textField(value: unknown, label: string, max = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw Object.assign(new Error(`${label} is required (maximum ${max} characters).`), { status: 400 });
  return value.trim();
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}
async function checkPassword(password: string, stored: string) {
  const [salt, expected] = stored.split(':');
  const actual = await scrypt(password, salt, 64) as Buffer;
  const target = Buffer.from(expected, 'hex');
  return target.length === actual.length && timingSafeEqual(target, actual);
}
function sessionToken(req: Request) {
  return req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
}
export async function loadIdentity(req: Request, res: Response, next: NextFunction) {
  try {
    // The scheme is case-insensitive per the HTTP spec, so "bearer" must work too.
    const bearer = req.headers.authorization?.match(/^Bearer (aoc_[A-Za-z0-9_-]+)$/i)?.[1];
    const session = sessionToken(req);
    const fields = 'u.id, u.org_id, u.email, u.name, w.name AS workspace_name';
    let rows: any[] = [];
    if (bearer) rows = await query(`SELECT ${fields}, k.id AS key_id FROM api_keys k JOIN users u ON u.id=k.user_id JOIN workspaces w ON w.id=k.org_id WHERE k.token_hash=$1 AND k.revoked_at IS NULL`, [digest(bearer)]);
    else if (session && session.length < 200) rows = await query(`SELECT ${fields} FROM sessions s JOIN users u ON u.id=s.user_id JOIN workspaces w ON w.id=u.org_id WHERE s.token_hash=$1 AND s.expires_at > now()`, [digest(session)]);
    if (rows[0]) res.locals.identity = { ...rows[0], mode: bearer ? 'key' : 'session', key_id: bearer ? rows[0].key_id : null };
    next();
  } catch (error) { next(error); }
}
export function requireUser(_req: Request, res: Response, next: NextFunction) {
  if (!identity(res)) { res.status(401).json({ error: 'Please sign in to continue.' }); return; }
  next();
}
export function requireSession(_req: Request, res: Response, next: NextFunction) {
  if (identity(res)?.mode !== 'session') { res.status(403).json({ error: 'A signed-in operator is required for this action.' }); return; }
  next();
}
export function checkOrigin(req: Request, res: Response, next: NextFunction) {
  if (['GET','HEAD','OPTIONS'].includes(req.method) || identity(res)?.mode === 'key') { next(); return; }
  // A key was offered and did not resolve. Reporting that as a bad origin sends
  // the caller hunting a CORS problem when the real answer is a bad key — and
  // they are indistinguishable from here, because an unresolved key leaves no
  // identity for the origin check to see. Say the useful thing instead.
  if (/^bearer /i.test(req.headers.authorization || '') && !identity(res)) {
    res.status(401).json({ error: 'That agent key is not valid or has been revoked.' }); return;
  }
  const expected = `${req.protocol}://${req.get('host')}`;
  if (req.get('origin') !== expected) { res.status(403).json({ error: 'Request origin is not allowed.' }); return; }
  next();
}
async function rateLimit(req: Request, res: Response, next: NextFunction) {
  try {
    // Do not trust caller-supplied forwarded IPs. Bound expensive password work per socket peer.
    const key = digest(req.ip || req.socket.remoteAddress || 'unknown');
    const rows = await query(`INSERT INTO auth_limits(key,attempts,expires_at) VALUES($1,1,now()+interval '15 minutes')
      ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN auth_limits.expires_at<now() THEN 1 ELSE auth_limits.attempts+1 END,
      expires_at=CASE WHEN auth_limits.expires_at<now() THEN now()+interval '15 minutes' ELSE auth_limits.expires_at END RETURNING attempts`, [key]);
    if (rows[0].attempts > 30) { res.set('Retry-After','900').status(429).json({ error: 'Too many attempts. Please try again in 15 minutes.' }); return; }
    next();
  } catch (e) { next(e); }
}
async function issueSession(req: Request, res: Response, userId: string) {
  const token = randomBytes(32).toString('base64url');
  const old = sessionToken(req);
  if (old) await query('DELETE FROM sessions WHERE token_hash=$1',[digest(old)]);
  await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')", [digest(token),userId]);
  res.cookie(cookieName,token,{ httpOnly:true, secure:req.secure, sameSite:'lax', maxAge:7*86400000, path:'/' });
}
export const authRouter = Router();
authRouter.post('/signup', rateLimit, async (req,res,next) => {
  try {
    const name = textField(req.body.name,'Full name',80);
    const workspace = textField(req.body.workspace,'Workspace name',80);
    const email = textField(req.body.email,'Email',254).toLowerCase();
    const password = req.body.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error:'Enter a valid email address.'});
    if (typeof password !== 'string' || password.length<12 || password.length>128) return res.status(400).json({error:'Use a password between 12 and 128 characters.'});
    const passwordHash = await hashPassword(password);
    const client = await pool.connect();
    let userId: string;
    try {
      await client.query('BEGIN');
      const org = await client.query('INSERT INTO workspaces(name) VALUES($1) RETURNING id',[workspace]);
      const result = await client.query('INSERT INTO users(org_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id',[org.rows[0].id,name,email,passwordHash]);
      userId=result.rows[0].id;
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    await issueSession(req,res,userId);
    res.status(201).json({ok:true});
  } catch(e: any) {
    if(e.code==='23505') return res.status(409).json({error:'An account with this email already exists. Sign in instead.'});
    next(e);
  }
});
authRouter.post('/login',rateLimit,async(req,res,next)=>{
  try {
    const email=textField(req.body.email,'Email',254).toLowerCase();
    const password=req.body.password;
    if(typeof password!=='string'||password.length>128) return res.status(400).json({error:'Enter your email and password.'});
    const users=await query('SELECT id,password_hash FROM users WHERE email=$1',[email]);
    const user=users[0];
    const valid=await checkPassword(password,user?.password_hash || `${'0'.repeat(32)}:${'0'.repeat(128)}`);
    if(!user||!valid) return res.status(401).json({error:'Email or password is incorrect.'});
    await issueSession(req,res,user.id);
    res.json({ok:true});
  } catch(e){next(e);}
});
authRouter.post('/password',rateLimit,requireUser,requireSession,async(req,res,next)=>{
  try {
    const user=identity(res), current=req.body.currentPassword, replacement=req.body.newPassword;
    if(typeof current!=='string'||typeof replacement!=='string') return res.status(400).json({error:'Enter your current and new password.'});
    if(replacement.length<12||replacement.length>128) return res.status(400).json({error:'Use a password between 12 and 128 characters.'});
    const users=await query('SELECT password_hash FROM users WHERE id=$1',[user.id]);
    const valid=await checkPassword(current,users[0]?.password_hash||`${'0'.repeat(32)}:${'0'.repeat(128)}`);
    if(!users[0]||!valid) return res.status(401).json({error:'Your current password is incorrect.'});
    const keep=digest(sessionToken(req)||'');
    await query('UPDATE users SET password_hash=$1 WHERE id=$2',[await hashPassword(replacement),user.id]);
    // A password change signs out every other session but keeps the one that made it.
    await query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2',[user.id,keep]);
    res.json({ok:true});
  } catch(e){next(e);}
});
authRouter.post('/logout',requireUser,requireSession,async(req,res)=>{
  await query('DELETE FROM sessions WHERE token_hash=$1',[digest(sessionToken(req)||'')]);
  res.clearCookie(cookieName,{path:'/',httpOnly:true,secure:req.secure,sameSite:'lax'});
  res.json({ok:true});
});
authRouter.get('/me',requireUser,(req,res)=>res.json(identity(res)));
