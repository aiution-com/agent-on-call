import { query, transaction } from './db';
import { notify } from './alerts';

/** The stop request is recorded; a worker that never checks in is an incident. */
export const STOP_ACK_INCIDENT = 'Agent has not acknowledged workspace stop';
const STOP_ACK_GRACE_SECONDS = 120;

/**
 * Expected acknowledgments are agents that had active work when the stop was
 * requested. A worker that never checks in may still be running an external
 * action, so an unacknowledged stop is escalated exactly once per agent.
 */
export async function inspectStopAcknowledgments(orgId: string, graceSeconds = STOP_ACK_GRACE_SECONDS) {
  const incidents: string[] = [];
  const count = await transaction(async client => {
    const workspace = (await client.query('SELECT halted, stop_requested_at FROM workspaces WHERE id=$1 FOR SHARE',[orgId])).rows[0];
    if (!workspace?.halted || !workspace.stop_requested_at) return 0;
    const requestedAt = new Date(workspace.stop_requested_at).getTime();
    if (!Number.isFinite(requestedAt) || Date.now() - requestedAt < graceSeconds * 1000) return 0;
    const pending = await client.query(`SELECT id FROM agents a
      WHERE a.org_id=$1 AND a.stop_requested_at IS NOT NULL AND a.stop_acknowledged_at IS NULL
      AND COALESCE(a.capabilities->>'sample','false')<>'true'
      AND NOT EXISTS(SELECT 1 FROM incidents i WHERE i.org_id=$1 AND i.agent_id=a.id AND i.title=$2 AND i.created_at>=a.stop_requested_at)
      FOR UPDATE`,[orgId,STOP_ACK_INCIDENT]);
    for (const agent of pending.rows) {
      const incident = await client.query("INSERT INTO incidents(org_id,agent_id,title,description,severity) VALUES($1,$2,$3,$4,'high') RETURNING id",[orgId,agent.id,STOP_ACK_INCIDENT,'The workspace was stopped but this agent has not checked in since. It may still be running an external action.']);
      incidents.push(incident.rows[0].id);
    }
    return pending.rowCount;
  });
  for (const incidentId of incidents) void notify(orgId,{type:'incident_created',incidentId});
  return count;
}

/** Marks unresponsive or over-budget tasks halted; adapters must enforce the stop. */
export async function inspectWorkspace(orgId: string) {
  const result = await transaction(async client => {
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[orgId]);
    const candidates=await client.query(`SELECT t.*, a.last_seen_at FROM tasks t JOIN agents a ON a.id=t.agent_id
      WHERE t.org_id=$1 AND t.status IN ('claimed','in_progress','paused')
      AND ((t.budget_usd IS NOT NULL AND t.spent_usd>=t.budget_usd)
        OR a.last_seen_at<now()-interval '3 minutes') FOR UPDATE OF t`,[orgId]);
    const incidents: string[] = [];
    for(const task of candidates.rows){
      const budget=task.budget_usd!==null && Number(task.spent_usd)>=Number(task.budget_usd);
      const reason=budget?'Reported budget limit reached':'Agent missed its heartbeat';
      await client.query("UPDATE tasks SET status='halted' WHERE id=$1",[task.id]);
      await client.query("UPDATE agents SET status='halted' WHERE id=$1",[task.agent_id]);
      const incident=await client.query("INSERT INTO incidents(org_id,agent_id,task_id,title,description,severity) VALUES($1,$2,$3,$4,$5,'high') RETURNING id",[orgId,task.agent_id,task.id,reason,'Task marked halted. The connected worker must stop before its next external action.']);
      await client.query("INSERT INTO task_logs(task_id,message,level) VALUES($1,$2,'warn')",[task.id,reason]);
      incidents.push(incident.rows[0].id);
    }
    return {count:candidates.rowCount,incidents};
  });
  for(const incidentId of result.incidents)void notify(orgId,{type:'incident_created',incidentId});
  return result.count;
}
/**
 * Workspaces the live watchdog cycle must inspect. 'paused' counts as active
 * work: a worker that dies while awaiting approval leaves only a paused task,
 * which is exactly when the operator most needs the stale-agent signal.
 */
export async function workspacesNeedingInspection(){
  const rows=await query("SELECT DISTINCT w.id FROM workspaces w LEFT JOIN tasks t ON t.org_id=w.id WHERE w.halted OR t.status IN ('claimed','in_progress','paused')");
  return rows.map((row:{id:string})=>row.id);
}
export function startWorkspaceWatchdog(){
  let running=false,cycles=0;
  const timer=setInterval(async()=>{
    if(running)return;
    running=true;
    try{
      const orgs=await workspacesNeedingInspection();
      for(const orgId of orgs){await inspectStopAcknowledgments(orgId);await inspectWorkspace(orgId);}
      if(cycles++%180===0){await query('DELETE FROM sessions WHERE expires_at<now()');await query('DELETE FROM auth_limits WHERE expires_at<now()');}
    }catch(error){console.error('[workspace watchdog]',error instanceof Error?error.message:'Cycle failed');}
    finally{running=false;}
  },20000);
  timer.unref();return ()=>clearInterval(timer);
}
