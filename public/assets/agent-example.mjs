// Run with Node.js 18+: AOC_API_URL=https://your-workspace AOC_API_KEY=aoc_... node agent-example.mjs
const base=(process.env.AOC_API_URL||'http://127.0.0.1:3000').replace(/\/$/,'');
const key=process.env.AOC_API_KEY;
if(!key){console.error('Set AOC_API_KEY to an agent key from your workspace.');process.exit(1);}
async function api(path,method='GET',body){
  const response=await fetch(`${base}/api/v1${path}`,{method,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const data=await response.json();if(!response.ok)throw new Error(data.error||`Request failed: ${response.status}`);return data;
}
let agent,task;
// A stop is a request until the worker says it saw it. Tell the workspace before exiting.
async function acknowledgeStop(){
  if(!agent)return;
  try{const status=await api('/emergency/status');if(status.isHalted)await api(`/agents/${agent.id}/stop-ack`,'POST');}catch{}
}
try{
  agent=await api('/agents','POST',{name:'My first agent',type:'example-worker',capabilities:{runtime:'node'}});
  task=await api('/tasks','POST',{title:'Report my Node.js environment',description:'Example integration: waits for approval, then reports the Node.js version. No shell command or paid API call.',source:'example-worker'});
  await api(`/tasks/${task.id}/claim`,'POST',{agentId:agent.id});
  await api(`/tasks/${task.id}/status`,'PATCH',{status:'in_progress'});
  await api(`/tasks/${task.id}/logs`,'POST',{message:'Connected successfully. Preparing an environment report.'});
  const approval=await api('/approvals','POST',{taskId:task.id,agentId:agent.id,type:'report_environment',context:{action:'Report Node.js version and operating-system platform',effect:'Writes an activity log in this workspace. No files or other systems are changed.'}});
  console.log(`Connected. Open ${base}/dashboard#approvals and review the request.`);
  let approved=false;
  for(let i=0;i<150;i++){
    await new Promise(resolve=>setTimeout(resolve,2000));
    const [decision,current,emergency]=await Promise.all([api(`/approvals/${approval.id}`),api(`/tasks/${task.id}`),api('/emergency/status')]);
    // Rejection is checked first: the server marks a rejected task failed in the
    // same transaction, so the generic "stopped" branch would otherwise swallow it.
    if(decision.status==='rejected'){
      // A denied action is worth a record: the agent tried to act and was stopped.
      // A real integration should report whatever its operator needs to follow up on.
      await api('/incidents','POST',{agentId:agent.id,taskId:task.id,title:'Action rejected by operator',description:'The requested action was rejected. The agent stopped and no external action was taken.',severity:'warning'}).catch(()=>{});
      throw new Error('Operator rejected the action.');
    }
    if(emergency.isHalted||['halted','failed'].includes(current.status)){
      if(emergency.isHalted)await api(`/agents/${agent.id}/stop-ack`,'POST').catch(()=>{});
      throw new Error('Task stopped. No action was executed.');
    }
    if(decision.status==='approved'&&current.status==='in_progress'){approved=true;break;}
    await api(`/agents/${agent.id}/status`,'PATCH',{status:'blocked'});
  }
  if(!approved)throw new Error('Approval timed out after five minutes.');
  // Re-check before the protected action; external adapters must also cooperate with stop signals.
  const [current,emergency]=await Promise.all([api(`/tasks/${task.id}`),api('/emergency/status')]);
  if(emergency.isHalted||current.status!=='in_progress'){
    if(emergency.isHalted)await api(`/agents/${agent.id}/stop-ack`,'POST').catch(()=>{});
    throw new Error('Task cannot continue.');
  }
  await api(`/tasks/${task.id}/logs`,'POST',{message:`Approved report: Node.js ${process.version} on ${process.platform}.`,level:'success'});
  await api(`/tasks/${task.id}/status`,'PATCH',{status:'done'});
  console.log('Completed. Open Tasks → Activity to see the result.');
}catch(error){
  await acknowledgeStop();
  console.error(error.message);
  if(task){await api(`/tasks/${task.id}/logs`,'POST',{message:error.message,level:'error'}).catch(()=>{});const current=await api(`/tasks/${task.id}`).catch(()=>null);if(current&&['claimed','in_progress','paused'].includes(current.status))await api(`/tasks/${task.id}/status`,'PATCH',{status:'failed'}).catch(()=>{});}
  process.exitCode=1;
}
