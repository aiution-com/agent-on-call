import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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
async function signup(label){const email=`aoc-test-${randomUUID()}@example.test`, password='test-password-84!';const r=await request('/api/auth/signup',{method:'POST',body:{name:label,workspace:label+' workspace',email,password}});assert.equal(r.status,201);assert.match(r.headers.get('set-cookie'),/HttpOnly/i);assert.match(r.headers.get('set-cookie'),/SameSite=Lax/i);const me=await request('/api/auth/me',{cookie:r.cookie});created.push(me.data.org_id);return {cookie:r.cookie,profile:me.data,email,password};}
try{
 await test('onboarding, workspace isolation, operator gates, sessions and agent lifecycle',async t=>{
  const a=await signup('Alice'), b=await signup('Bob');
  const call=(path,method='GET',body)=>request('/api/v1'+path,{method,body,cookie:a.cookie});
  await t.test('anonymous requests and forged origins are blocked',async()=>{
   assert.equal((await request('/dashboard')).status,302);
   assert.equal((await request('/api/v1/agents')).status,401);
   assert.equal((await request('/api/v1/tasks',{cookie:a.cookie,method:'POST',body:{title:'Blocked'},origin:'https://other.test'})).status,403);
   assert.equal((await request('/api/v1/tasks',{cookie:a.cookie,method:'POST',body:{title:'Blocked'},origin:null})).status,403);
   assert.equal((await request('/dashboard',{cookie:a.cookie})).status,200);
  });
  let agent,task,key,approval;
  await t.test('new workspace is empty; profile updates persist',async()=>{
   assert.deepEqual((await call('/agents')).data,[]);
   assert.deepEqual((await call('/tasks')).data,[]);
   assert.equal((await call('/profile','PATCH',{name:'Alice Updated',workspace:'My workspace'})).status,200);
   assert.equal((await call('/workspace')).data.profile.name,'Alice Updated');
   const row=(await pool.query('SELECT password_hash FROM users WHERE id=$1',[a.profile.id])).rows[0];assert.notEqual(row.password_hash,a.password);assert.match(row.password_hash,/^[a-f0-9]+:[a-f0-9]+$/);
  });
  await t.test('workspace keys connect an agent and do not leak on reads',async()=>{
   const result=await call('/keys','POST',{name:'Test agent'});assert.equal(result.status,201);key=result.data;
   assert.ok(key.token);assert.equal((await call('/keys')).data[0].token,undefined);
   const r=await request('/api/v1/agents',{method:'POST',key:key.token,origin:null,body:{name:'Connected worker',type:'test'}});assert.equal(r.status,201);agent=r.data;
   const queued=await call('/tasks','POST',{title:'Review changes',budgetUsd:5});assert.equal(queued.status,201);task=queued.data;
   assert.equal((await call('/workspace')).data.progress.agent,true);
  });
  await t.test('another user cannot list, read, mutate or reference our records',async()=>{
   const other=(path,method='GET',body)=>request('/api/v1'+path,{cookie:b.cookie,method,body});
   assert.deepEqual((await other('/agents')).data,[]);
   assert.equal((await other('/agents?orgId='+a.profile.org_id)).status,403);
   assert.equal((await other('/agents/'+agent.id)).status,404);
   assert.equal((await other('/tasks/'+task.id+'/logs')).status,404);
   assert.equal((await other('/tasks/'+task.id+'/status','PATCH',{status:'halted'})).status,404);
   assert.equal((await other('/incidents','POST',{agentId:agent.id,title:'Cross-tenant'})).status,404);
   assert.equal((await other('/keys/'+key.id,'DELETE')).status,404);
   assert.equal((await other('/tasks','POST',{title:'Cross-tenant',orgId:a.profile.org_id})).status,403);
  });
  const machine=(path,method='GET',body)=>request('/api/v1'+path,{key:key.token,origin:null,method,body});
  await t.test('agent claims, reports and waits; only owner can approve',async()=>{
   assert.equal((await machine(`/tasks/${task.id}/claim`,'POST',{agentId:agent.id})).status,200);
   assert.equal((await machine(`/tasks/${task.id}/claim`,'POST',{agentId:agent.id})).status,409);
   assert.equal((await machine(`/tasks/${task.id}/status`,'PATCH',{status:'in_progress'})).status,200);
   assert.equal((await machine(`/tasks/${task.id}/logs`,'POST',{message:'Ready to review'})).status,201);
   const r=await machine('/approvals','POST',{taskId:task.id,agentId:agent.id,type:'review',context:{action:'Check result'}});assert.equal(r.status,201);approval=r.data;
   assert.equal((await machine(`/tasks/${task.id}`)).data.status,'paused');
   assert.equal((await machine(`/tasks/${task.id}/status`,'PATCH',{status:'done'})).status,409);
   assert.equal((await machine(`/approvals/${approval.id}/decide`,'POST',{decision:'approved'})).status,403);
   assert.equal((await machine('/emergency/stop','POST',{})).status,403);
   assert.equal((await request(`/api/v1/approvals/${approval.id}/decide`,{cookie:b.cookie,method:'POST',body:{decision:'approved'}})).status,404);
   const outcomes=await Promise.all([call(`/approvals/${approval.id}/decide`,'POST',{decision:'approved'}),call(`/approvals/${approval.id}/decide`,'POST',{decision:'approved'})]);assert.deepEqual(outcomes.map(x=>x.status).sort(),[200,409]);
   assert.equal((await machine(`/tasks/${task.id}/status`,'PATCH',{status:'done'})).status,200);
   assert.equal((await call(`/tasks/${task.id}/logs`)).data.length,3);
  });
  await t.test('stop blocks new claims and requires explicit restart',async()=>{
   const r=await call('/tasks','POST',{title:'Second task'});const id=r.data.id;
   await machine(`/tasks/${id}/claim`,'POST',{agentId:agent.id});
   assert.equal((await call('/emergency/stop','POST',{})).status,200);
   assert.equal((await machine(`/tasks/${id}`)).data.status,'halted');
   assert.equal((await machine(`/tasks/${id}/status`,'PATCH',{status:'queued'})).status,403);
   assert.equal((await call('/emergency/resume','POST',{})).status,200);
   assert.equal((await machine(`/tasks/${id}`)).data.status,'halted');
   assert.equal((await call(`/tasks/${id}/status`,'PATCH',{status:'queued'})).status,200);
   assert.equal((await machine(`/tasks/${id}/claim`,'POST',{agentId:agent.id})).status,200);
  });
  await t.test('sample creates one practice request and completes without external effects',async()=>{
   const r=await request('/api/v1/onboarding/sample',{cookie:b.cookie,method:'POST',body:{}});assert.equal(r.status,201);
   const again=await request('/api/v1/onboarding/sample',{cookie:b.cookie,method:'POST',body:{}});assert.equal(r.data.id,again.data.id);
   const approvals=(await request('/api/v1/approvals',{cookie:b.cookie})).data;
   assert.equal((await request(`/api/v1/approvals/${approvals[0].id}/decide`,{cookie:b.cookie,method:'POST',body:{decision:'approved'}})).status,200);
   assert.equal((await request('/api/v1/tasks/'+r.data.id,{cookie:b.cookie})).data.status,'done');
  });
  await t.test('budget monitoring halts only the affected workspace',async()=>{
   const limited=(await call('/tasks','POST',{title:'Budget check',budgetUsd:1})).data;
   await machine(`/tasks/${limited.id}/claim`,'POST',{agentId:agent.id});
   await machine(`/tasks/${limited.id}/status`,'PATCH',{status:'in_progress'});
   await machine(`/tasks/${limited.id}/spend`,'POST',{amountUsd:1});
   const {inspectWorkspace}=require('../dist/workspace-watchdog.js');
   assert.equal(await inspectWorkspace(a.profile.org_id),1);
   assert.equal(await inspectWorkspace(a.profile.org_id),0);
   assert.equal((await call('/tasks/'+limited.id)).data.status,'halted');
  });
  await t.test('downloadable example connects, waits for operator approval, and completes',async()=>{
   const child=spawn(process.execPath,['public/assets/agent-example.mjs'],{env:{...process.env,AOC_API_URL:base,AOC_API_KEY:key.token},stdio:['ignore','pipe','pipe']});
   let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
   const exited=once(child,'exit');
   try{
    let pending;
    for(let i=0;i<60;i++){pending=(await call('/approvals')).data.find(a=>a.type==='report_environment');if(pending)break;await new Promise(r=>setTimeout(r,100));}
    assert.ok(pending,'Example must request approval');
    await call(`/approvals/${pending.id}/decide`,'POST',{decision:'approved'});
    const [code]=await Promise.race([exited,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Example timed out')),10000);timer.unref();})]);
    assert.equal(code,0,output);
    assert.equal((await call('/tasks/'+pending.task_id)).data.status,'done');
    assert.match(output,/Completed/);
   }finally{if(child.exitCode===null)child.kill();}
  });
  await t.test('MCP connects over the scoped API without database credentials',async()=>{
   const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
   const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
   const client=new Client({name:'mvp-check',version:'1.0.0'});
   const transport=new StdioClientTransport({command:process.execPath,args:['dist/mcp/server.js'],env:{PATH:process.env.PATH,AOC_API_URL:base,AOC_API_KEY:key.token}});
   try{await client.connect(transport);const tools=await client.listTools();assert.equal(tools.tools.length,8);const result=await client.callTool({name:'register_agent',arguments:{name:'MCP test agent',type:'test'}});assert.ok(!result.isError);const record=JSON.parse(result.content[0].text);assert.equal(record.org_id,a.profile.org_id);}finally{await client.close();}
  });
  await t.test('revoking key and logging out revoke access',async()=>{
   assert.equal((await call('/keys/'+key.id,'DELETE')).status,200);
   assert.equal((await machine('/tasks')).status,401);
   assert.equal((await request('/api/auth/login',{method:'POST',body:{email:a.email,password:'wrong-password'}})).status,401);
   assert.equal((await request('/api/auth/logout',{method:'POST',cookie:a.cookie,body:{}})).status,200);
   assert.equal((await call('/workspace')).status,401);
   const login=await request('/api/auth/login',{method:'POST',body:{email:a.email,password:a.password}});assert.equal(login.status,200);
  });
 });
}finally{
 for(const org of created){await pool.query('DELETE FROM approval_requests WHERE task_id IN(SELECT id FROM tasks WHERE org_id=$1)',[org]);await pool.query('DELETE FROM incidents WHERE org_id=$1',[org]);await pool.query('DELETE FROM tasks WHERE org_id=$1',[org]);await pool.query('DELETE FROM agents WHERE org_id=$1',[org]);await pool.query('DELETE FROM policies WHERE org_id=$1',[org]);await pool.query('DELETE FROM workspaces WHERE id=$1',[org]);}
 await pool.query("DELETE FROM auth_limits WHERE key=$1",[require('../dist/auth.js').digest('127.0.0.1')]);
 await new Promise(resolve=>server.close(resolve));await pool.end();
}
