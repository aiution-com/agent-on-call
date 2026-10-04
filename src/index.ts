import express from 'express';
import path from 'path';
import { pool } from './db';
import { authRouter, loadIdentity, requireUser, checkOrigin, identity } from './auth';
import { workspaceApi } from './workspace-api';
import { startWorkspaceWatchdog } from './workspace-watchdog';
import { host, port, trustProxy } from './config';

export const app = express();
app.disable('x-powered-by');
// Which proxy to believe is a deployment decision, not a constant: the default
// suits cloudflared on loopback, and a proxy in its own container needs a
// different answer. See docs/DEPLOY.md.
app.set('trust proxy',trustProxy);
app.use((req,res,next)=>{
  res.set('X-Content-Type-Options','nosniff');
  res.set('Referrer-Policy','same-origin');
  res.set('X-Frame-Options','DENY');
  res.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.set('Cache-Control','no-store');
  next();
});
app.use(express.json({limit:'32kb'}));
app.get('/health',async(_req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true});}catch{res.status(503).json({ok:false});}});
app.use('/assets',express.static(path.join(__dirname,'../public/assets'),{dotfiles:'deny'}));
app.use(loadIdentity);
app.use('/api',checkOrigin);
app.use('/api/auth',authRouter);
app.use('/api/v1',requireUser,workspaceApi);
app.get(['/', '/login', '/signup'],(req,res)=>{
  if(identity(res)?.mode==='session')return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname,'../public/auth.html'));
});
app.get('/dashboard',(req,res)=>{
  if(identity(res)?.mode!=='session')return res.redirect('/login');
  res.sendFile(path.join(__dirname,'../public/dashboard.html'));
});
// Deliberately reachable without signing in: the people who most need it are the
// ones who have just landed and do not yet know what this is.
app.get('/help',(_req,res)=>res.sendFile(path.join(__dirname,'../public/help.html')));
app.use((_req,res)=>res.status(404).json({error:'Page not found.'}));
app.use((err:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  const status=err.status || (['22P02','23514','23502'].includes(err.code)?400:500);
  if(status>=500)console.error('[api]',err.message);
  res.status(status).json({error:status>=500?'Something went wrong. Please try again.':err.message||'Invalid request.'});
});
if(require.main===module){
  const server=app.listen(port,host,()=>console.log(`AgentOnCall listening on ${host}:${port}`));
  const stopWatchdog=startWorkspaceWatchdog();
  const stop=()=>{stopWatchdog();server.close(()=>{pool.end().finally(()=>process.exit(0));});};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
