import express from 'express';
import path from 'path';
import { pool } from './db';
import { authRouter, loadIdentity, requireUser, checkOrigin, identity } from './auth';
import { workspaceApi } from './workspace-api';
import { startWorkspaceWatchdog } from './workspace-watchdog';

export const app = express();
app.disable('x-powered-by');
// cloudflared connects over loopback; accept proxy metadata only from that peer.
app.set('trust proxy','loopback');
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
app.use((_req,res)=>res.status(404).json({error:'Page not found.'}));
app.use((err:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  const status=err.status || (['22P02','23514','23502'].includes(err.code)?400:500);
  if(status>=500)console.error('[api]',err.message);
  res.status(status).json({error:status>=500?'Something went wrong. Please try again.':err.message||'Invalid request.'});
});
if(require.main===module){
  const server=app.listen(Number(process.env.PORT)||3000,'127.0.0.1',()=>console.log('AgentOnCall listening on localhost:'+ (process.env.PORT||3000)));
  const stopWatchdog=startWorkspaceWatchdog();
  const stop=()=>{stopWatchdog();server.close(()=>{pool.end().finally(()=>process.exit(0));});};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
