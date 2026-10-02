/**
 * Pure Slack Block Kit builders. This module must not import anything: it is used by
 * the per-workspace alerting path, which must not load a database pool or the Slack
 * webhook client the way src/slack.ts does.
 */

// Approval card. The actions block is only useful to a caller that can receive button
// clicks; AgentOnCall cannot, so the alert path passes { actions: false }.
export function buildApprovalBlocks(approval: any, task: any, agent: any, options: { actions?: boolean } = {}): any[] {
  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: approval.amount_usd
          ? `🔴 Approval needed: $${approval.amount_usd}`
          : `🟡 Approval needed: ${approval.type}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Task:* ${task.title}\n*Agent:* ${agent.name} (${agent.type})\n*Requested:* <!date^${Math.floor(new Date(approval.requested_at).getTime() / 1000)}^{date_shorty} {time}|${approval.requested_at}>`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*What the agent wants to do:*\n\`\`\`${JSON.stringify(approval.context, null, 2)}\`\`\``,
      },
    },
  ];
  if (options.actions === false) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Approval \`${approval.id}\` · Decide it in your AgentOnCall dashboard. Notifications are one-way.` }],
    });
    return blocks;
  }
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        style: 'primary',
        text: { type: 'plain_text', text: '✅ Approve' },
        action_id: 'approval_approve',
        value: JSON.stringify({ approval_id: approval.id, decision: 'approved' }),
      },
      {
        type: 'button',
        style: 'danger',
        text: { type: 'plain_text', text: '❌ Reject' },
        action_id: 'approval_reject',
        value: JSON.stringify({ approval_id: approval.id, decision: 'rejected' }),
      },
    ],
  });
  return blocks;
}

export function buildIncidentBlocks(incident: any, workspace: any): any[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🔺 ${incident.severity} incident: ${incident.title}` },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: incident.description ? `*${incident.title}*\n${incident.description}` : `*${incident.title}*`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Workspace: ${workspace.name} · Incident \`${incident.id}\`` }],
    },
  ];
}

export function buildHaltedBlocks(summary: any, workspace: any): any[] {
  return [
    { type: 'header', text: { type: 'plain_text', text: '⛔ Workspace stopped' } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${workspace.name}* was stopped by ${summary.stopped_by}. New claims are blocked until an operator reopens it.`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${summary.halted_tasks} task(s) and ${summary.halted_agents} agent(s) marked halted. This is a cooperative signal and does not terminate external processes.`,
        },
      ],
    },
  ];
}

export function buildTestBlocks(workspace: any): any[] {
  return [
    { type: 'header', text: { type: 'plain_text', text: '🔔 Test alert' } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `This is a test alert from AgentOnCall for *${workspace.name}*. A working destination receives approval requests, new incidents, and workspace stops.`,
      },
    },
  ];
}

// Update the original Slack message when a decision replaces the buttons.
export function buildDecisionBlocks(approvalId: string, decision: string, decidedBy: string, originalBlocks: any[]): any[] {
  const resultBlocks: any[] = [];
  for (const block of originalBlocks) {
    if (block.type !== 'actions') {
      resultBlocks.push(block);
    }
  }
  resultBlocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Result:* ${decision === 'approved' ? '✅ Approved' : '❌ Rejected'} by ${decidedBy}`,
    },
  });
  return resultBlocks;
}
