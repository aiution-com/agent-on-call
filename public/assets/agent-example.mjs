// Run with Node.js 18+: AOC_API_URL=https://your-workspace AOC_API_KEY=aoc_... node agent-example.mjs
const base=(process.env.AOC_API_URL||'http://127.0.0.1:3000').replace(/\/$/,'');
const key=process.env.AOC_API_KEY;
if(!key){console.error('Set AOC_API_KEY to an agent key from your workspace.');process.exit(1);}
async function api(path,method='GET',body){
  const response=await fetch(`${base}/api/v1${path}`,{method,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const data=await response.json();if(!response.ok)throw new Error(data.error||`Request failed: ${response.status}`);return data;
}
let task;
try{
  const agent=await api('/agents','POST',{name:'My first agent',type:'example-worker',capabilities:{runtime:'node'}});
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
    if(emergency.isHalted||['halted','failed'].includes(current.status))throw new Error('Task stopped. No action was executed.');
    if(decision.status==='rejected')throw new Error('Operator rejected the action.');
    if(decision.status==='approved'&&current.status==='in_progress'){approved=true;break;}
    await api(`/agents/${agent.id}/status`,'PATCH',{status:'blocked'});
  }
  if(!approved)throw new Error('Approval timed out after five minutes.');
  // Re-check before the protected action; external adapters must also cooperate with stop signals.
  const [current,emergency]=await Promise.all([api(`/tasks/${task.id}`),api('/emergency/status')]);
  if(emergency.isHalted||current.status!=='in_progress')throw new Error('Task cannot continue.');
  await api(`/tasks/${task.id}/logs`,'POST',{message:`Approved report: Node.js ${process.version} on ${process.platform}.`,level:'success'});
  await api(`/tasks/${task.id}/status`,'PATCH',{status:'done'});
  console.log('Completed. Open Tasks → Activity to see the result.');
}catch(error){
  console.error(error.message);
  if(task){await api(`/tasks/${task.id}/logs`,'POST',{message:error.message,level:'error'}).catch(()=>{});const current=await api(`/tasks/${task.id}`).catch(()=>null);if(current&&['claimed','in_progress','paused'].includes(current.status))await api(`/tasks/${task.id}/status`,'PATCH',{status:'failed'}).catch(()=>{});}
  process.exitCode=1;
}
