/**
 * Pure Slack Block Kit builders. This module must not import anything: it is used by
 * the per-workspace alerting path, which must not load a database pool or a
 * network client.
 */

// Slack parses mrkdwn in these strings. Task titles, agent names and incident
// text are agent-controlled, so escape the three characters that create
// mentions (<!channel>) and links (<https://…|text>).
const escape = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
          : `🟡 Approval needed: ${escape(approval.type)}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Task:* ${escape(task.title)}\n*Agent:* ${escape(agent.name)} (${escape(agent.type)})\n*Requested:* <!date^${Math.floor(new Date(approval.requested_at).getTime() / 1000)}^{date_shorty} {time}|${escape(approval.requested_at)}>`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*What the agent wants to do:*\n\`\`\`${escape(JSON.stringify(approval.context, null, 2))}\`\`\``,
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
      text: { type: 'plain_text', text: `🔺 ${escape(incident.severity)} incident: ${escape(incident.title)}` },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: incident.description ? `*${escape(incident.title)}*\n${escape(incident.description)}` : `*${escape(incident.title)}*`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Workspace: ${escape(workspace.name)} · Incident \`${escape(incident.id)}\`` }],
    },
  ];
}

export function buildHaltedBlocks(summary: any, workspace: any): any[] {
  const stopLine = summary.agents_notified
    ? `Stop signal sent to ${summary.agents_notified} active agent(s); ${summary.agents_acknowledged} of ${summary.agents_notified} acknowledged.`
    : 'No active agents were running at the time.';
  return [
    { type: 'header', text: { type: 'plain_text', text: '⛔ Workspace stopped' } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${escape(workspace.name)}* was stopped by ${escape(summary.stopped_by)}. New claims are blocked until an operator reopens it.`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${summary.halted_tasks} task(s) halted. ${stopLine} Follow acknowledgments in the dashboard. This is a cooperative signal and does not terminate external processes.`,
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
        text: `This is a test alert from AgentOnCall for *${escape(workspace.name)}*. A working destination receives approval requests, new incidents, and workspace stops.`,
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
      text: `*Result:* ${decision === 'approved' ? '✅ Approved' : '❌ Rejected'} by ${escape(decidedBy)}`,
    },
  });
  return resultBlocks;
}
