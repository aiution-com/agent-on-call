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
  await t.test('block builders are pure and the alert path does not load a database pool',async()=>{
   const {buildApprovalBlocks,buildDecisionBlocks,buildIncidentBlocks,buildHaltedBlocks,buildTestBlocks}=require('../dist/alert-blocks.js');
   const approval={id:'11111111-1111-1111-1111-111111111111',type:'review',amount_usd:null,context:{action:'Check result'},requested_at:'2026-10-03T10:00:00.000Z'};
   const task={title:'Review the latest pull request'};
   const agent={name:'Connected worker',type:'test'};
   const withActions=buildApprovalBlocks(approval,task,agent);
   assert.equal(withActions.at(-1).type,'actions');
   assert.equal(withActions.at(-1).elements.length,2);
   const withoutActions=buildApprovalBlocks(approval,task,agent,{actions:false});
   assert.equal(withoutActions.some(b=>b.type==='actions'),false);
   assert.equal(withoutActions.at(-1).type,'context');
   assert.match(JSON.stringify(withoutActions),/Review the latest pull request/);
   assert.match(JSON.stringify(withoutActions),/11111111-1111-1111-1111-111111111111/);
   assert.match(JSON.stringify(withoutActions),/in your AgentOnCall dashboard/);
   const decided=buildDecisionBlocks(approval.id,'approved','Alice',withActions);
   assert.equal(decided.some(b=>b.type==='actions'),false);
   assert.match(JSON.stringify(decided),/Approved by Alice/);
   assert.match(JSON.stringify(buildIncidentBlocks({id:'x',title:'Budget limit reached',description:'Spend reached the limit.',severity:'high'},{name:'My workspace'})),/\*Budget limit reached\*/);
   assert.match(JSON.stringify(buildHaltedBlocks({stopped_by:'Alice',halted_tasks:2,halted_agents:1},{name:'My workspace'})),/2 task\(s\) and 1 agent\(s\)/);
   assert.match(JSON.stringify(buildTestBlocks({name:'My workspace'})),/Test alert/);
  });
  await t.test('importing the block builders loads no dependencies',async()=>{
   const {execFileSync}=await import('node:child_process');
   const target=JSON.stringify(require.resolve('../dist/alert-blocks.js'));
   const probe=execFileSync(process.execPath,['-e',`require(${target});const external=Object.keys(require.cache).filter(k=>k.includes('node_modules'));console.log(JSON.stringify(external));`],{encoding:'utf8'});
   assert.deepEqual(JSON.parse(probe),[]);
  });
  await t.test('alert URLs are validated and internal addresses are refused',async()=>{
   const {validChannelUrl,isBlockedAddress,assertDeliverableAddress}=require('../dist/alert-url.js');
   const ok=validChannelUrl('https://hooks.slack.com/services/T000/B000/XXXX');
   assert.equal(ok.url,'https://hooks.slack.com/services/T000/B000/XXXX');
   assert.equal(ok.host,'hooks.slack.com');
   const bad=(value,label)=>{assert.throws(()=>validChannelUrl(value),error=>error.status===400,label);};
   bad('http://hooks.slack.com/services/x','http must be refused');
   bad('not a url','garbage must be refused');
   bad('https://user:pass@hooks.slack.com/x','embedded credentials must be refused');
   bad('https://localhost/hook','localhost must be refused');
   bad('https://127.0.0.1/hook','loopback must be refused');
   bad('https://169.254.169.254/latest/meta-data','link-local metadata must be refused');
   bad('https://10.0.0.5/hook','private range must be refused');
   bad('https://192.168.1.10/hook','private range must be refused');
   bad('https://172.16.4.4/hook','private range must be refused');
   bad('https://[::1]/hook','IPv6 loopback must be refused');
   bad('https://[::ffff:7f00:1]/hook','IPv4-mapped loopback must be refused');
   bad('https://[::ffff:a9fe:a9fe]/latest/meta-data','IPv4-mapped metadata must be refused');
   bad('https://[::ffff:a00:5]/hook','IPv4-mapped private range must be refused');
   bad('https://[fec0::1]/hook','deprecated site-local must be refused');
   bad('https://localhost./hook','localhost with a trailing dot must be refused');
   bad('https://x.test/'+'a'.repeat(1200),'over-long URL must be refused');
   for(const allowed of ['https://100.128.0.1/hook','https://172.32.0.1/hook','https://11.0.0.1/hook','https://[2606:4700::1111]/hook'])validChannelUrl(allowed);
   for(const address of ['127.0.0.1','10.1.2.3','169.254.169.254','172.20.0.1','192.168.0.1','100.64.0.1','0.0.0.0','224.0.0.1','::1','::','fd00::1','fe80::1','fec0::1','::ffff:127.0.0.1','::ffff:7f00:1','::ffff:a9fe:a9fe'])assert.equal(isBlockedAddress(address),true,address);
   for(const address of ['93.184.216.34','8.8.8.8','2606:4700::1111','::ffff:8.8.8.8','::ffff:808:808','100.128.0.1','172.32.0.1'])assert.equal(isBlockedAddress(address),false,address);
   await assert.rejects(assertDeliverableAddress('169.254.169.254'));
   await assert.rejects(assertDeliverableAddress('localhost'));
   await assert.doesNotReject(assertDeliverableAddress('93.184.216.34'));
  });
 });
}finally{
 for(const org of created){await pool.query('DELETE FROM approval_requests WHERE task_id IN(SELECT id FROM tasks WHERE org_id=$1)',[org]);await pool.query('DELETE FROM incidents WHERE org_id=$1',[org]);await pool.query('DELETE FROM tasks WHERE org_id=$1',[org]);await pool.query('DELETE FROM agents WHERE org_id=$1',[org]);await pool.query('DELETE FROM policies WHERE org_id=$1',[org]);await pool.query('DELETE FROM workspaces WHERE id=$1',[org]);}
 await pool.query("DELETE FROM auth_limits WHERE key=$1",[require('../dist/auth.js').digest('127.0.0.1')]);
 await new Promise(resolve=>server.close(resolve));await pool.end();
}
