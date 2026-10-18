import { Router } from 'express';
import { randomBytes } from 'crypto';
import { query, transaction, pool } from './db';
import { identity, requireSession, digest, textField } from './auth';
import { listChannels, saveChannel, removeChannel, sendTest, notify } from './alerts';
import { STOP_ACK_INCIDENT } from './workspace-watchdog';

export const workspaceApi = Router();
const fail = (message:string,status=400): never => { throw Object.assign(new Error(message),{status}); };
const uuid = (v:unknown):string => typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : fail('Invalid record ID.');
const amount = (v:unknown,optional=false):number|null => v==null && optional ? null : typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100000000 ? v : fail('Amount must be a non-negative number.');
const object = (v:unknown):object => v===undefined ? {} : v!==null&&typeof v==='object'&&!Array.isArray(v) ? v : fail('Expected an object.');
const found = (rows:any[]) => rows[0] || fail('Record not found.',404);
type Queryable = { query:(text:string,params?:any[])=>Promise<{rows:any[]}> };
/**
 * An agent key may only act as the agents it registered. Agents created before
 * key binding existed have a NULL owner and stay usable by any key in their
 * workspace, so existing deployments keep working.
 */
async function scopedAgent(c:Queryable,orgId:string,agentId:string,keyId?:string|null){
  const agent=found((await c.query('SELECT id,created_by_key_id FROM agents WHERE id=$1 AND org_id=$2',[agentId,orgId])).rows);
  if(keyId && agent.created_by_key_id && agent.created_by_key_id!==keyId) fail('This agent belongs to another key.',403);
  return agent;
}
const tables:Record<string,string>={agents:'agents',tasks:'tasks',incidents:'incidents',policies:'policies'};
workspaceApi.use((req,res,next)=>{
  const org=identity(res).org_id;
  if ((req.body?.orgId && req.body.orgId!==org)||(req.query.orgId && req.query.orgId!==org)) return res.status(403).json({error:'Workspace access denied.'});
  next();
});
workspaceApi.get('/workspace',requireSession,async(req,res)=>{
  const user=identity(res);
  const [agents,tasks,approvals,keys]=await Promise.all([
    query("SELECT count(*)::int AS total FROM agents WHERE org_id=$1 AND COALESCE(capabilities->>'sample','false')<>'true'",[user.org_id]),
    query("SELECT count(*)::int AS total FROM tasks WHERE org_id=$1 AND source<>'sample'",[user.org_id]),
    query("SELECT count(*)::int AS total FROM approval_requests a JOIN tasks t ON t.id=a.task_id WHERE t.org_id=$1 AND a.status<>'pending'",[user.org_id]),
    query('SELECT count(*)::int AS total FROM api_keys WHERE org_id=$1 AND revoked_at IS NULL',[user.org_id])
  ]);
  res.json({profile:user,progress:{agent:agents[0].total>0,task:tasks[0].total>0,approval:approvals[0].total>0,key:keys[0].total>0}});
});
workspaceApi.patch('/profile',requireSession,async(req,res)=>{
  const u=identity(res), name=textField(req.body.name,'Full name',80), workspace=textField(req.body.workspace,'Workspace name',80);
  await transaction(async c=>{await c.query('UPDATE users SET name=$1 WHERE id=$2',[name,u.id]);await c.query('UPDATE workspaces SET name=$1 WHERE id=$2',[workspace,u.org_id]);});
  res.json({ok:true});
});
workspaceApi.get('/keys',requireSession,async(req,res)=>res.json(await query('SELECT id,name,prefix,created_at,revoked_at FROM api_keys WHERE org_id=$1 ORDER BY created_at DESC',[identity(res).org_id])));
workspaceApi.post('/keys',requireSession,async(req,res)=>{
  const u=identity(res), name=textField(req.body.name,'Key name',80), token=`aoc_${randomBytes(32).toString('base64url')}`;
  const key=await transaction(async c=>{
    await c.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[u.org_id]);
    const count=await c.query('SELECT count(*)::int AS total FROM api_keys WHERE org_id=$1 AND revoked_at IS NULL',[u.org_id]);
    if(count.rows[0].total>=10) fail('Revoke an existing key before creating another (limit 10).');
    return (await c.query('INSERT INTO api_keys(org_id,user_id,name,token_hash,prefix) VALUES($1,$2,$3,$4,$5) RETURNING id,name,prefix,created_at',[u.org_id,u.id,name,digest(token),token.slice(0,12)])).rows[0];
  });
  res.status(201).json({...key,token});
});
workspaceApi.delete('/keys/:id',requireSession,async(req,res)=>{
  found(await query('UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND org_id=$2 RETURNING id',[uuid(req.params.id),identity(res).org_id]));res.json({ok:true});
});
for(const [path,table] of Object.entries(tables)) {
  workspaceApi.get(`/${path}`,async(req,res)=>{
    const params:any[]=[identity(res).org_id];let filter='';
    if(req.query.status && table!=='policies'){params.push(textField(req.query.status,'Status',40));filter=' AND status=$2';}
    res.json(await query(`SELECT * FROM ${table} WHERE org_id=$1${filter} ORDER BY created_at DESC LIMIT 200`,params));
  });
  workspaceApi.get(`/${path}/:id`,async(req,res)=>res.json(found(await query(`SELECT * FROM ${table} WHERE id=$1 AND org_id=$2`,[uuid(req.params.id),identity(res).org_id]))));
}
workspaceApi.post('/agents',async(req,res)=>{
  const u=identity(res), name=textField(req.body.name,'Agent name',80), type=textField(req.body.type||'worker','Agent type',80);
  res.status(201).json(found(await query("INSERT INTO agents(org_id,name,type,owner_email,capabilities,status,last_seen_at,created_by_key_id) VALUES($1,$2,$3,$4,$5,'idle',now(),$6) RETURNING *",[u.org_id,name,type,u.email,JSON.stringify({...object(req.body.capabilities),sample:false}),u.key_id||null])));
});
workspaceApi.patch('/agents/:id/status',async(req,res)=>{
  if(!['idle','busy','blocked','halted','stuck'].includes(req.body.status)) fail('Invalid agent status.');
  const health=req.body.healthScore;
  if(health!==undefined&&(typeof health!=='number'||!Number.isFinite(health)||health<0||health>100))fail('Health must be between 0 and 100.');
  const u=identity(res),id=uuid(req.params.id);
  await scopedAgent(pool,u.org_id,id,u.key_id);
  res.json(found(await query("UPDATE agents SET status=CASE WHEN (SELECT halted FROM workspaces WHERE id=$2) THEN 'halted' ELSE $3 END,health_score=COALESCE($4,health_score),last_seen_at=now() WHERE id=$1 AND org_id=$2 RETURNING *",[id,u.org_id,req.body.status,health])));
});
// A stop is only confirmed when a worker says it saw the stop. Any authenticated
// agent call could be made by a worker that ignores the answer, so acknowledgment
// is a separate, explicit signal.
workspaceApi.post('/agents/:id/stop-ack',async(req,res)=>{
  const u=identity(res),id=uuid(req.params.id);
  if(u.mode!=='key')fail('Only an agent can acknowledge a stop.',403);
  const agent=await transaction(async c=>{
    const w=found((await c.query('SELECT halted FROM workspaces WHERE id=$1 FOR SHARE',[u.org_id])).rows);
    if(!w.halted)fail('Workspace is not stopped.',409);
    await scopedAgent(c,u.org_id,id,u.key_id);
    const updated=found((await c.query("UPDATE agents SET stop_acknowledged_at=COALESCE(stop_acknowledged_at,now()),status='halted',last_seen_at=now() WHERE id=$1 AND org_id=$2 RETURNING *",[id,u.org_id])).rows);
    await c.query("UPDATE incidents SET status='resolved',resolved_at=now() WHERE org_id=$1 AND agent_id=$2 AND title=$3 AND status='open'",[u.org_id,updated.id,STOP_ACK_INCIDENT]);
    return updated;
  });
  res.json(agent);
});
// A stop is only confirmed when a worker says it saw the stop. Any authenticated
// agent call could be made by a worker that ignores the answer, so acknowledgment
// is a separate, explicit signal.
workspaceApi.post('/agents/:id/stop-ack',async(req,res)=>{
  const u=identity(res);
  if(u.mode!=='key')fail('Only an agent can acknowledge a stop.',403);
  const agent=await transaction(async c=>{
    const w=found((await c.query('SELECT halted FROM workspaces WHERE id=$1 FOR SHARE',[u.org_id])).rows);
    if(!w.halted)fail('Workspace is not stopped.',409);
    const updated=found((await c.query("UPDATE agents SET stop_acknowledged_at=COALESCE(stop_acknowledged_at,now()),status='halted',last_seen_at=now() WHERE id=$1 AND org_id=$2 RETURNING *",[uuid(req.params.id),u.org_id])).rows);
    await c.query("UPDATE incidents SET status='resolved',resolved_at=now() WHERE org_id=$1 AND agent_id=$2 AND title=$3 AND status='open'",[u.org_id,updated.id,STOP_ACK_INCIDENT]);
    return updated;
  });
  res.json(agent);
});
workspaceApi.post('/tasks',async(req,res)=>{
  const b=req.body, timeout=b.timeoutSeconds??3600;
  if(b.source==='sample')fail('The sample source is reserved for onboarding.');
  if(!Number.isInteger(timeout)||timeout<30||timeout>86400)fail('Timeout must be between 30 and 86400 seconds.');
  res.status(201).json(found(await query("INSERT INTO tasks(org_id,title,description,source,status,budget_usd,permissions,required_approvals,timeout_seconds) VALUES($1,$2,$3,$4,'queued',$5,$6,'[]',$7) RETURNING *",[identity(res).org_id,textField(b.title,'Task title',200),typeof b.description==='string'?b.description.slice(0,5000):'',textField(b.source||'dashboard','Source',40),amount(b.budgetUsd,true),JSON.stringify(object(b.permissions)),timeout])));
});
workspaceApi.post('/tasks/:id/claim',async(req,res)=>{
  const u=identity(res),org=u.org_id,id=uuid(req.params.id),agentId=uuid(req.body.agentId);
  const task=await transaction(async c=>{
    const w=found((await c.query('SELECT halted FROM workspaces WHERE id=$1 FOR SHARE',[org])).rows);
    if(w.halted)fail('Workspace is stopped.',409);
    await scopedAgent(c,org,agentId,u.key_id);
    const rows=(await c.query("UPDATE tasks SET agent_id=$3,status='claimed',claimed_at=now() WHERE id=$1 AND org_id=$2 AND status='queued' RETURNING *",[id,org,agentId])).rows;
    if(!rows[0])fail('Task is unavailable for claiming.',409);
    await c.query("UPDATE agents SET status='busy',last_seen_at=now() WHERE id=$1",[agentId]);
    return rows[0];
  });res.json(task);
});
workspaceApi.patch('/tasks/:id/status',async(req,res)=>{
  const u=identity(res),id=uuid(req.params.id),status=req.body.status;
  const transitions:Record<string,string[]>={queued:['halted'],claimed:['in_progress','failed','halted'],in_progress:['done','failed','halted'],paused:['failed','halted'],halted:['queued'],done:[],failed:[]};
  const result=await transaction(async c=>{
    const w=found((await c.query('SELECT halted FROM workspaces WHERE id=$1 FOR SHARE',[u.org_id])).rows);
    const task=found((await c.query('SELECT * FROM tasks WHERE id=$1 AND org_id=$2 FOR UPDATE',[id,u.org_id])).rows);
    if(task.agent_id)await scopedAgent(c,u.org_id,task.agent_id,u.key_id);
    if(!transitions[task.status]?.includes(status))fail('Task cannot make that status transition.',409);
    if(status==='queued' && u.mode!=='session')fail('Only an operator can restart a halted task.',403);
    if(w.halted && !['failed','halted'].includes(status))fail('Workspace is stopped.',409);
    const updated=(await c.query("UPDATE tasks SET status=$2,agent_id=CASE WHEN $2='queued' THEN NULL ELSE agent_id END,claimed_at=CASE WHEN $2='queued' THEN NULL ELSE claimed_at END,started_at=CASE WHEN $2='queued' THEN NULL WHEN $2='in_progress' THEN COALESCE(started_at,now()) ELSE started_at END,completed_at=CASE WHEN $2='queued' THEN NULL WHEN $2 IN ('done','failed') THEN now() ELSE completed_at END WHERE id=$1 RETURNING *",[id,status])).rows[0];
    if(task.agent_id && ['done','failed','halted','queued'].includes(status)) await c.query("UPDATE agents SET status='idle',last_seen_at=now() WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM tasks WHERE agent_id=$1 AND status IN ('claimed','in_progress','paused'))",[task.agent_id]);
    return updated;
  });res.json(result);
});
workspaceApi.post('/tasks/:id/spend',async(req,res)=>{
  const u=identity(res),id=uuid(req.params.id),amountUsd=amount(req.body.amountUsd) as number;
  const task=await transaction(async c=>{
    const task=found((await c.query('SELECT * FROM tasks WHERE id=$1 AND org_id=$2 FOR UPDATE',[id,u.org_id])).rows);
    if(task.agent_id)await scopedAgent(c,u.org_id,task.agent_id,u.key_id);
    if(!['claimed','in_progress'].includes(task.status))fail('Spend can only be reported for a claimed or in-progress task.',409);
    const updated=(await c.query('UPDATE tasks SET spent_usd=spent_usd+$3 WHERE id=$1 AND org_id=$2 RETURNING *',[id,u.org_id,amountUsd])).rows[0];
    await c.query("INSERT INTO task_logs(task_id,message,level) VALUES($1,$2,'info')",[id,`Reported spend: $${amountUsd.toFixed(2)}.`]);
    return updated;
  });
  res.json(task);
});
workspaceApi.get('/tasks/:id/logs',async(req,res)=>{
  const id=uuid(req.params.id),org=identity(res).org_id;
  found(await query('SELECT id FROM tasks WHERE id=$1 AND org_id=$2',[id,org]));
  res.json(await query('SELECT * FROM (SELECT l.* FROM task_logs l JOIN tasks t ON t.id=l.task_id WHERE t.id=$1 AND t.org_id=$2 ORDER BY l.timestamp DESC,l.id DESC LIMIT 500) recent ORDER BY timestamp,id',[id,org]));
});
workspaceApi.post('/tasks/:id/logs',async(req,res)=>{
  const u=identity(res),id=uuid(req.params.id),level=req.body.level||'info';
  if(!['info','warn','error','pause','stdout','success'].includes(level))fail('Invalid log level.');
  const task=found(await query('SELECT agent_id FROM tasks WHERE id=$1 AND org_id=$2',[id,u.org_id]));
  if(task.agent_id)await scopedAgent(pool,u.org_id,task.agent_id,u.key_id);
  res.status(201).json(found(await query('INSERT INTO task_logs(task_id,message,level) SELECT id,$3,$4 FROM tasks WHERE id=$1 AND org_id=$2 RETURNING *',[id,u.org_id,textField(req.body.message,'Message',16000),level])));
});
workspaceApi.get('/approvals',async(req,res)=>res.json(await query("SELECT a.*,t.title AS task_title,g.name AS agent_name FROM approval_requests a JOIN tasks t ON t.id=a.task_id JOIN agents g ON g.id=a.agent_id WHERE t.org_id=$1 AND a.status='pending' ORDER BY a.requested_at DESC LIMIT 200",[identity(res).org_id])));
workspaceApi.get('/approvals/:id',async(req,res)=>res.json(found(await query('SELECT a.* FROM approval_requests a JOIN tasks t ON t.id=a.task_id WHERE a.id=$1 AND t.org_id=$2',[uuid(req.params.id),identity(res).org_id]))));
workspaceApi.post('/approvals',async(req,res)=>{
  const u=identity(res),org=u.org_id,taskId=uuid(req.body.taskId),agentId=uuid(req.body.agentId),type=textField(req.body.type,'Action type',80);
  const result=await transaction(async c=>{
    const w=found((await c.query('SELECT halted FROM workspaces WHERE id=$1 FOR SHARE',[org])).rows);if(w.halted)fail('Workspace is stopped.',409);
    const task=found((await c.query('SELECT * FROM tasks WHERE id=$1 AND org_id=$2 FOR UPDATE',[taskId,org])).rows);
    if(task.agent_id!==agentId||!['claimed','in_progress'].includes(task.status))fail('Claim and start the task before requesting approval.',409);
    await scopedAgent(c,org,agentId,u.key_id);
    const a=(await c.query("INSERT INTO approval_requests(task_id,agent_id,type,amount_usd,context,status) VALUES($1,$2,$3,$4,$5,'pending') RETURNING *",[taskId,agentId,type,amount(req.body.amountUsd,true),JSON.stringify(object(req.body.context))])).rows[0];
    await c.query("UPDATE tasks SET status='paused' WHERE id=$1",[taskId]);
    await c.query("INSERT INTO task_logs(task_id,message,level) VALUES($1,$2,'pause')",[taskId,`Waiting for operator approval: ${type}`]);return a;
  });void notify(org,{type:'approval_requested',approvalId:result.id});res.status(201).json(result);
});
workspaceApi.post('/approvals/:id/decide',requireSession,async(req,res)=>{
  const u=identity(res),id=uuid(req.params.id),decision=req.body.decision;
  if(!['approved','rejected'].includes(decision))fail('Invalid decision.');
  const result=await transaction(async c=>{
    const w=found((await c.query('SELECT halted FROM workspaces WHERE id=$1 FOR SHARE',[u.org_id])).rows);
    const a=found((await c.query('SELECT a.*,t.source AS task_source FROM approval_requests a JOIN tasks t ON t.id=a.task_id WHERE a.id=$1 AND t.org_id=$2 FOR UPDATE OF a,t',[id,u.org_id])).rows);
    if(a.status!=='pending')fail('Approval was already decided.',409);
    const updated=(await c.query('UPDATE approval_requests SET status=$2,decided_at=now(),decided_by=$3,decision_reason=$4 WHERE id=$1 RETURNING *',[id,decision,u.email,typeof req.body.reason==='string'?req.body.reason.slice(0,2000):null])).rows[0];
    await c.query("UPDATE tasks SET status=CASE WHEN $2='rejected' THEN 'failed' WHEN $3 THEN status WHEN status='paused' THEN 'in_progress' ELSE status END,completed_at=CASE WHEN $2='rejected' THEN now() ELSE completed_at END WHERE id=$1",[a.task_id,decision,w.halted]);
    await c.query("INSERT INTO task_logs(task_id,message,level) VALUES($1,$2,'info')",[a.task_id,`${decision==='approved'?'Approved':'Rejected'} by ${u.name}.`]);
    if(a.task_source==='sample' && decision==='approved' && !w.halted) await c.query("UPDATE tasks SET status='done',completed_at=now() WHERE id=$1 AND status='in_progress'",[a.task_id]);
    if(a.task_source==='sample'||decision==='rejected') await c.query("UPDATE agents SET status='idle',last_seen_at=now() WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM tasks WHERE agent_id=$1 AND status IN ('claimed','in_progress','paused','halted'))",[a.agent_id]);
    return updated;
  });res.json(result);
});
workspaceApi.post('/incidents',async(req,res)=>{
  const u=identity(res),org=u.org_id;
  if(String(req.body.title||'').trim()===STOP_ACK_INCIDENT)fail('That incident title is reserved.',403);
  if(req.body.agentId)await scopedAgent(pool,org,uuid(req.body.agentId),u.key_id);
  if(req.body.taskId){
    const task=found(await query('SELECT agent_id FROM tasks WHERE id=$1 AND org_id=$2',[uuid(req.body.taskId),org]));
    if(task.agent_id)await scopedAgent(pool,org,task.agent_id,u.key_id);
  }
  const severity=req.body.severity||'warning';if(!['info','warning','high','critical'].includes(severity))fail('Invalid severity.');
  const incident=found(await query('INSERT INTO incidents(org_id,agent_id,task_id,title,description,severity,evidence) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[org,req.body.agentId||null,req.body.taskId||null,textField(req.body.title,'Title',200),String(req.body.description||'').slice(0,5000),severity,JSON.stringify(object(req.body.evidence))]));
  void notify(org,{type:'incident_created',incidentId:incident.id});
  res.status(201).json(incident);
});
workspaceApi.post('/incidents/:id/resolve',requireSession,async(req,res)=>res.json(found(await query("UPDATE incidents SET status='resolved',resolved_at=now() WHERE id=$1 AND org_id=$2 RETURNING *",[uuid(req.params.id),identity(res).org_id]))));
workspaceApi.post('/policies',requireSession,async(req,res)=>res.status(201).json(found(await query('INSERT INTO policies(org_id,rule_type,rule_value,agent_type) VALUES($1,$2,$3,$4) RETURNING *',[identity(res).org_id,textField(req.body.ruleType,'Rule type',80),JSON.stringify(object(req.body.ruleValue)),req.body.agentType?textField(req.body.agentType,'Agent type',80):null]))));
workspaceApi.get('/emergency/status',async(req,res)=>{
  const w=found(await query('SELECT halted,stop_requested_at FROM workspaces WHERE id=$1',[identity(res).org_id]));
  res.json({isHalted:w.halted,stopRequestedAt:w.stop_requested_at});
});
workspaceApi.post('/emergency/stop',requireSession,async(req,res)=>{
  const u=identity(res);let stopRequestedAt:Date|null=null;
  const stopped=await transaction(async c=>{
    const w=found((await c.query('SELECT halted,stop_requested_at FROM workspaces WHERE id=$1 FOR UPDATE',[u.org_id])).rows);
    if(w.halted){stopRequestedAt=w.stop_requested_at;return;}
    await c.query('UPDATE agents SET stop_requested_at=NULL,stop_acknowledged_at=NULL WHERE org_id=$1',[u.org_id]);
    stopRequestedAt=(await c.query('UPDATE workspaces SET halted=true,stop_requested_at=now() WHERE id=$1 RETURNING stop_requested_at',[u.org_id])).rows[0].stop_requested_at;
    // Only workers that had active work are expected to acknowledge. Agents that
    // already exited are not made to look unresponsive.
    await c.query("UPDATE agents a SET stop_requested_at=$2 WHERE a.org_id=$1 AND COALESCE(a.capabilities->>'sample','false')<>'true' AND EXISTS(SELECT 1 FROM tasks t WHERE t.agent_id=a.id AND t.status IN ('claimed','in_progress','paused'))",[u.org_id,stopRequestedAt]);
    await c.query("UPDATE tasks SET status='halted' WHERE org_id=$1 AND status IN ('claimed','in_progress','paused')",[u.org_id]);
    return (await c.query("INSERT INTO incidents(org_id,title,description,severity) VALUES($1,'EMERGENCY STOP: Workspace paused',$2,'critical') RETURNING id",[u.org_id,`Stopped by ${u.name}. Agent integrations must acknowledge the stop when they see it and must not act before that.`])).rows[0];
  });if(stopped)void notify(u.org_id,{type:'incident_created',incidentId:stopped.id});if(stopped)void notify(u.org_id,{type:'workspace_halted',stoppedBy:u.name});res.json({ok:true,stopRequestedAt});
});
workspaceApi.post('/emergency/resume',requireSession,async(req,res)=>{
  const org=identity(res).org_id;await transaction(async c=>{
    await c.query('UPDATE workspaces SET halted=false,stop_requested_at=NULL WHERE id=$1',[org]);
    await c.query("UPDATE agents SET status=CASE WHEN status='halted' THEN 'idle' ELSE status END,stop_requested_at=NULL,stop_acknowledged_at=NULL WHERE org_id=$1",[org]);
    await c.query("UPDATE incidents SET status='resolved',resolved_at=now() WHERE org_id=$1 AND status='open' AND title IN ('EMERGENCY STOP: Workspace paused',$2)",[org,STOP_ACK_INCIDENT]);
  });res.json({ok:true,message:'Workspace reopened. Restart halted tasks individually.'});
});
workspaceApi.post('/onboarding/sample',requireSession,async(req,res)=>{
  const u=identity(res);
  const result=await transaction(async c=>{
    const w=found((await c.query('SELECT halted FROM workspaces WHERE id=$1 FOR UPDATE',[u.org_id])).rows);if(w.halted)fail('Resume your workspace first.',409);
    const existing=await c.query("SELECT id FROM tasks WHERE org_id=$1 AND source='sample' LIMIT 1",[u.org_id]);if(existing.rows[0])return existing.rows[0];
    const agent=(await c.query("INSERT INTO agents(org_id,name,type,owner_email,status,capabilities,last_seen_at) VALUES($1,'Sample agent','sample',$2,'blocked','{\"sample\":true}',now()) RETURNING id",[u.org_id,u.email])).rows[0];
    const task=(await c.query("INSERT INTO tasks(org_id,agent_id,title,description,source,status,budget_usd) VALUES($1,$2,'Review a sample deployment','A practice approval. No code is deployed and no money is spent.','sample','paused',0) RETURNING id",[u.org_id,agent.id])).rows[0];
    await c.query("INSERT INTO approval_requests(task_id,agent_id,type,context) VALUES($1,$2,'sample_deployment',$3)",[task.id,agent.id,JSON.stringify({sample:true,action:'Approve a practice deployment',effect:'No external action will run.'})]);
    await c.query("INSERT INTO task_logs(task_id,message,level) VALUES($1,'Sample task created. Waiting for your approval. No external action will run.','pause')",[task.id]);return task;
  });res.status(201).json(result);
});
workspaceApi.get('/alerts',requireSession,async(req,res)=>res.json({channels:await listChannels(identity(res).org_id)}));
workspaceApi.put('/alerts',requireSession,async(req,res)=>res.json({ok:true,...await saveChannel(identity(res).org_id,req.body)}));
workspaceApi.delete('/alerts',requireSession,async(req,res)=>{await removeChannel(identity(res).org_id,req.query.kind);res.json({ok:true});});
workspaceApi.post('/alerts',requireSession,async(req,res)=>res.json(await sendTest(identity(res).org_id)));
// Legacy demos execute host commands or notify a shared Slack channel. They are not public workspace endpoints.
workspaceApi.use((_req,res)=>res.status(404).json({error:'Endpoint not found.'}));
