#!/usr/bin/env node
/**
 * AgentOnCall MCP Server
 * 
 * Lets any MCP-compatible agent (Claude Code, Codex, Cursor, custom) connect to AgentOnCall
 * and do the full task lifecycle: register, claim, report progress, request approval, complete.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const apiUrl = (process.env.AOC_API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const apiKey = process.env.AOC_API_KEY;
async function api(path: string, method = 'GET', body?: object): Promise<any> {
  if (!apiKey) throw new Error('Set AOC_API_KEY to a workspace agent key.');
  const response = await fetch(`${apiUrl}/api/v1${path}`, {
    method, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
  });
  const data = await response.json() as any;
  if (!response.ok) throw new Error(data.error || 'API request failed.');
  return data;
}

const server = new Server(
  { name: 'agentoncall-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'register_agent',
      description: 'Register this agent with AgentOnCall. Call once at startup.',
      inputSchema: {
        type: 'object',
        properties: {
          org_id: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string' },
          owner_email: { type: 'string' },
          capabilities: { type: 'object' },
        },
        required: ['name', 'type'],
      },
    },
    {
      name: 'list_available_tasks',
      description: 'List unclaimed tasks for an org.',
      inputSchema: {
        type: 'object',
        properties: {
          org_id: { type: 'string' },
          limit: { type: 'number' },
        },
        required: [],
      },
    },
    {
      name: 'claim_task',
      description: 'Claim a task atomically.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          agent_id: { type: 'string' },
        },
        required: ['task_id', 'agent_id'],
      },
    },
    {
      name: 'report_progress',
      description: 'Report progress on a claimed task.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          agent_id: { type: 'string' },
          message: { type: 'string' },
          spent_usd: { type: 'number' },
          health_score: { type: 'number' },
        },
        required: ['task_id', 'agent_id', 'message'],
      },
    },
    {
      name: 'request_approval',
      description: 'Request human approval. Pauses task.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          agent_id: { type: 'string' },
          type: { type: 'string' },
          amount_usd: { type: 'number' },
          context: { type: 'object' },
          approver_chain: { type: 'array', items: { type: 'string' } },
        },
        required: ['task_id', 'agent_id', 'type', 'context'],
      },
    },
    {
      name: 'check_approval_status',
      description: 'Check if approval decided.',
      inputSchema: {
        type: 'object',
        properties: { approval_id: { type: 'string' } },
        required: ['approval_id'],
      },
    },
    {
      name: 'complete_task',
      description: 'Mark task done/failed.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          agent_id: { type: 'string' },
          status: { type: 'string', enum: ['done', 'failed'] },
          outcome: { type: 'string' },
        },
        required: ['task_id', 'agent_id', 'status', 'outcome'],
      },
    },
    {
      name: 'get_agent_status',
      description: 'Get agent status.',
      inputSchema: {
        type: 'object',
        properties: { agent_id: { type: 'string' } },
        required: ['agent_id'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args || {}) as Record<string, any>;
  const id = (value: unknown) => {
    if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Invalid record ID.');
    return value;
  };
  try {
    let result: any;
    switch (name) {
      case 'register_agent': result = await api('/agents', 'POST', { name:a.name,type:a.type,capabilities:a.capabilities }); break;
      case 'list_available_tasks': result = (await api('/tasks?status=queued')).slice(0,Math.max(1,Math.min(Number(a.limit)||10,200))); break;
      case 'claim_task':
        result = await api(`/tasks/${id(a.task_id)}/claim`, 'POST', {agentId:id(a.agent_id)});
        result = await api(`/tasks/${id(a.task_id)}/status`, 'PATCH', {status:'in_progress'}); break;
      case 'report_progress':
        if (a.spent_usd !== undefined) await api(`/tasks/${id(a.task_id)}/spend`,'POST',{amountUsd:a.spent_usd});
        await api(`/agents/${id(a.agent_id)}/status`,'PATCH',{status:'busy',healthScore:a.health_score});
        result = await api(`/tasks/${id(a.task_id)}/logs`,'POST',{message:a.message}); break;
      case 'request_approval': result = await api('/approvals','POST',{taskId:id(a.task_id),agentId:id(a.agent_id),type:a.type,amountUsd:a.amount_usd,context:a.context}); break;
      case 'check_approval_status': {
        const approval = await api(`/approvals/${id(a.approval_id)}`);
        const task = await api(`/tasks/${approval.task_id}`);
        const emergency = await api('/emergency/status');
        result = {...approval,task_status:task.status,may_execute:approval.status==='approved'&&task.status==='in_progress'&&!emergency.isHalted}; break;
      }
      case 'complete_task':
        result = await api(`/tasks/${id(a.task_id)}/status`,'PATCH',{status:a.status});
        await api(`/tasks/${id(a.task_id)}/logs`,'POST',{message:a.outcome}); break;
      case 'get_agent_status': result = {agent:await api(`/agents/${id(a.agent_id)}`),emergency:await api('/emergency/status')}; break;
      default: throw new Error('Unknown tool.');
    }
    return {content:[{type:'text',text:JSON.stringify(result,null,2)}]};
  } catch (err: any) { return {isError:true,content:[{type:'text',text:err.message}]}; }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch((err) => { console.error(err); process.exit(1); });
