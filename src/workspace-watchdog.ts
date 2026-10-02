import { query, transaction } from './db';

/** Marks unresponsive or over-budget tasks halted; adapters must enforce the stop. */
export async function inspectWorkspace(orgId: string) {
  return transaction(async client => {
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[orgId]);
    const candidates=await client.query(`SELECT t.*, a.last_seen_at FROM tasks t JOIN agents a ON a.id=t.agent_id
      WHERE t.org_id=$1 AND t.status IN ('claimed','in_progress')
      AND ((t.budget_usd IS NOT NULL AND t.spent_usd>=t.budget_usd)
        OR a.last_seen_at<now()-interval '3 minutes') FOR UPDATE OF t`,[orgId]);
    for(const task of candidates.rows){
      const budget=task.budget_usd!==null && Number(task.spent_usd)>=Number(task.budget_usd);
      const reason=budget?'Reported budget limit reached':'Agent missed its heartbeat';
      await client.query("UPDATE tasks SET status='halted' WHERE id=$1",[task.id]);
      await client.query("UPDATE agents SET status='halted' WHERE id=$1",[task.agent_id]);
      await client.query("INSERT INTO incidents(org_id,agent_id,task_id,title,description,severity) VALUES($1,$2,$3,$4,$5,'high')",[orgId,task.agent_id,task.id,reason,'Task marked halted. The connected worker must stop before its next external action.']);
      await client.query("INSERT INTO task_logs(task_id,message,level) VALUES($1,$2,'warn')",[task.id,reason]);
    }
    return candidates.rowCount;
  });
}
export function startWorkspaceWatchdog(){
  let running=false,cycles=0;
  const timer=setInterval(async()=>{
    if(running)return;
    running=true;
    try{
      const orgs=await query("SELECT DISTINCT w.id FROM workspaces w JOIN tasks t ON t.org_id=w.id WHERE t.status IN ('claimed','in_progress')");
      for(const org of orgs)await inspectWorkspace(org.id);
      if(cycles++%180===0){await query('DELETE FROM sessions WHERE expires_at<now()');await query('DELETE FROM auth_limits WHERE expires_at<now()');}
    }catch(error){console.error('[workspace watchdog]',error instanceof Error?error.message:'Cycle failed');}
    finally{running=false;}
  },20000);
  timer.unref();return ()=>clearInterval(timer);
}
