import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require=createRequire(import.meta.url);
const {app}=require('../dist/index.js');
const {pool}=require('../dist/db.js');
const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const created=[];
async function request(path,{method='GET',body,cookie,key,origin=base}={}){
  const response=await fetch(base+path,{method,redirect:'manual',headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(key?{Authorization:`Bearer ${key}`}:{ }),...(origin?{Origin:origin}:{})},body:body?JSON.stringify(body):undefined});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
}
async function signup(label){const email=`aoc-alert-${randomUUID()}@example.test`, password='test-password-84!';const r=await request('/api/auth/signup',{method:'POST',body:{name:label,workspace:label+' workspace',email,password}});assert.equal(r.status,201);const me=await request('/api/auth/me',{cookie:r.cookie});created.push(me.data.org_id);return {cookie:r.cookie,profile:me.data,email,password};}
try{
 await test('per-workspace alerts',async t=>{
  await t.test('the alert_channels table enforces one channel per kind and cascades with its workspace',async()=>{
   const org=(await pool.query("INSERT INTO workspaces(name) VALUES('Alert schema test') RETURNING id")).rows[0].id;
   created.push(org);
   await pool.query("INSERT INTO alert_channels(org_id,kind,url,secret) VALUES($1,'slack','https://example.test/one','')",[org]);
   await assert.rejects(
    pool.query("INSERT INTO alert_channels(org_id,kind,url,secret) VALUES($1,'slack','https://example.test/two','')",[org]),
    error=>error.code==='23505'
   );
   await assert.rejects(
    pool.query("INSERT INTO alert_channels(org_id,kind,url,secret) VALUES($1,'sms','https://example.test/three','')",[org]),
    error=>error.code==='23514'
   );
   const throwaway=(await pool.query("INSERT INTO workspaces(name) VALUES('Alert cascade test') RETURNING id")).rows[0].id;
   await pool.query("INSERT INTO alert_channels(org_id,kind,url,secret) VALUES($1,'webhook','https://example.test/four','secret-value-1234')",[throwaway]);
   await pool.query('DELETE FROM workspaces WHERE id=$1',[throwaway]);
   assert.equal((await pool.query('SELECT 1 FROM alert_channels WHERE org_id=$1',[throwaway])).rowCount,0);
  });
 });
}finally{
 for(const org of created){await pool.query('DELETE FROM approval_requests WHERE task_id IN(SELECT id FROM tasks WHERE org_id=$1)',[org]);await pool.query('DELETE FROM incidents WHERE org_id=$1',[org]);await pool.query('DELETE FROM tasks WHERE org_id=$1',[org]);await pool.query('DELETE FROM agents WHERE org_id=$1',[org]);await pool.query('DELETE FROM policies WHERE org_id=$1',[org]);await pool.query('DELETE FROM workspaces WHERE id=$1',[org]);}
 await pool.query("DELETE FROM auth_limits WHERE key=$1",[require('../dist/auth.js').digest('127.0.0.1')]);
 await new Promise(resolve=>server.close(resolve));await pool.end();
}
