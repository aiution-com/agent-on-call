/** Workspace-scoped client. External actions must cooperate with stop signals. */
export interface AgentGuardConfig {
  apiUrl: string;
  apiKey?: string;
  orgId?: string;
  agentName: string;
  agentType?: string;
  ownerEmail?: string;
}
export interface GuardParams<T> {
  taskId?: string;
  taskTitle?: string;
  type: string;
  amountUsd?: number;
  context: Record<string, any>;
  action: () => Promise<T>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}
export class AgentGuard {
  public agentId: string | null = null;
  public apiUrl: string;
  private apiKey: string;
  constructor(private config: AgentGuardConfig) {
    this.apiUrl=config.apiUrl.replace(/\/$/,'');
    this.apiKey=config.apiKey||process.env.AOC_API_KEY||'';
  }
  private async api(path:string,method='GET',body?:object):Promise<any>{
    if(!this.apiKey)throw new Error('A workspace agent key is required.');
    const response=await fetch(`${this.apiUrl}/api/v1${path}`,{method,headers:{Authorization:`Bearer ${this.apiKey}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
    const data=await response.json() as any;
    if(!response.ok)throw new Error(data.error||'API request failed.');return data;
  }
  async init():Promise<string>{
    if(this.agentId)return this.agentId;
    const agent=await this.api('/agents','POST',{name:this.config.agentName,type:this.config.agentType||'sdk-worker',capabilities:{sdk:'agentoncall-v2'}});
    this.agentId=agent.id;return agent.id;
  }
  async guard<T>(params:GuardParams<T>):Promise<{approved:boolean;result?:T;reason?:string;approvalId:string}>{
    await this.init();
    let taskId=params.taskId;
    if(!taskId)taskId=(await this.api('/tasks','POST',{title:params.taskTitle||`Review ${params.type}`,source:'sdk',budgetUsd:params.amountUsd})).id;
    try{
      let task=await this.api(`/tasks/${taskId}`);
      if(task.status==='queued')task=await this.api(`/tasks/${taskId}/claim`,'POST',{agentId:this.agentId});
      if(task.agent_id!==this.agentId)throw new Error('This task is assigned to another agent.');
      if(task.status==='claimed')await this.api(`/tasks/${taskId}/status`,'PATCH',{status:'in_progress'});
      const approval=await this.api('/approvals','POST',{taskId,agentId:this.agentId,type:params.type,amountUsd:params.amountUsd,context:params.context});
      const deadline=Date.now()+(params.timeoutMs||300000);
      while(Date.now()<deadline){
        await new Promise(resolve=>setTimeout(resolve,Math.max(params.pollIntervalMs||2000,100)));
        const [decision,current,emergency]=await Promise.all([this.api(`/approvals/${approval.id}`),this.api(`/tasks/${taskId}`),this.api('/emergency/status')]);
        if(decision.status==='rejected')return {approved:false,reason:decision.decision_reason||'Rejected by operator',approvalId:approval.id};
        if(emergency.isHalted||['halted','failed'].includes(current.status))throw new Error('Workspace or task stopped.');
        if(decision.status==='approved'&&current.status==='in_progress'){
          const result=await params.action();
          await this.api(`/tasks/${taskId}/status`,'PATCH',{status:'done'});
          return {approved:true,result,approvalId:approval.id};
        }
        await this.api(`/agents/${this.agentId}/status`,'PATCH',{status:'blocked'});
      }
      throw new Error('Approval timed out.');
    }catch(error){
      const task=await this.api(`/tasks/${taskId}`).catch(()=>null);
      if(task&&['claimed','in_progress','paused'].includes(task.status))await this.api(`/tasks/${taskId}/status`,'PATCH',{status:'failed'}).catch(()=>{});
      throw error;
    }
  }
}
