/**
 * Per-workspace alerting. Every lookup here is filtered by org_id, so an alert can only
 * ever be built from the workspace that triggered it. Events carry record IDs rather than
 * rows for the same reason.
 *
 * Delivery is best effort: it is never awaited by a request handler, it is never retried,
 * and a failure is logged and dropped.
 */
import { createHmac } from 'node:crypto';
import { query } from './db';
import { buildApprovalBlocks, buildIncidentBlocks, buildHaltedBlocks, buildTestBlocks } from './alert-blocks';
import { validChannelUrl, assertDeliverableAddress } from './alert-url';

export type AlertEvent =
  | { type: 'approval_requested'; approvalId: string }
  | { type: 'incident_created'; incidentId: string }
  | { type: 'workspace_halted'; stoppedBy: string };

export interface DeliveryResult { kind: string; ok: boolean; status?: number; error?: string }
export type AlertTransport = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: 'error'; signal: AbortSignal }) => Promise<{ status: number }>;

interface BuiltAlert { event: string; text: string; blocks: any[]; data: Record<string, unknown> }

const TIMEOUT_MS = 5000;
const inFlight = new Set<Promise<unknown>>();
let transport: AlertTransport | null = null;

/** Installs a test double for outgoing deliveries. Pass null to restore fetch. */
export function setAlertTransport(next: AlertTransport | null) { transport = next; }

/** Waits for every notification started so far. Used by tests to avoid polling. */
export async function flushAlerts(): Promise<void> {
  while (inFlight.size) await Promise.all([...inFlight]);
}

export function signBody(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** Channel list for the operator API. The secret is not selected, so it cannot leak. */
export async function listChannels(orgId: string) {
  return query('SELECT kind, url, updated_at FROM alert_channels WHERE org_id=$1 ORDER BY kind', [orgId]);
}

/** Delivery view, including the signing key. Never serialize this into a response. */
export async function readDeliveryChannels(orgId: string) {
  return query('SELECT kind, url, secret FROM alert_channels WHERE org_id=$1 ORDER BY kind', [orgId]);
}

export async function saveChannel(orgId: string, body: any) {
  const kind = body?.kind;
  if (kind !== 'slack' && kind !== 'webhook') throw Object.assign(new Error('Choose an alert destination type.'), { status: 400 });
  const url = validChannelUrl(body?.url).url;
  const provided = typeof body?.secret === 'string' ? body.secret.trim() : '';
  const existing = (await query('SELECT secret FROM alert_channels WHERE org_id=$1 AND kind=$2', [orgId, kind]))[0];
  if (kind === 'slack' && provided) throw Object.assign(new Error('Slack channels do not use a signing secret.'), { status: 400 });
  if (kind === 'webhook') {
    if (provided && (provided.length < 16 || provided.length > 200)) throw Object.assign(new Error('The signing secret must be between 16 and 200 characters.'), { status: 400 });
    if (!provided && !existing) throw Object.assign(new Error('A signing secret of at least 16 characters is required.'), { status: 400 });
  }
  const secret = kind === 'slack' ? '' : (provided || existing.secret);
  const rows = await query(
    `INSERT INTO alert_channels(org_id, kind, url, secret) VALUES($1, $2, $3, $4)
     ON CONFLICT(org_id, kind) DO UPDATE SET url=$3, secret=$4, updated_at=now()
     RETURNING kind, url, updated_at`,
    [orgId, kind, url, secret]
  );
  return rows[0];
}

export async function removeChannel(orgId: string, kind: unknown): Promise<void> {
  if (kind !== 'slack' && kind !== 'webhook') throw Object.assign(new Error('Choose an alert destination type.'), { status: 400 });
  const rows = await query('DELETE FROM alert_channels WHERE org_id=$1 AND kind=$2 RETURNING kind', [orgId, kind]);
  if (!rows.length) throw Object.assign(new Error('No alert channel is configured for that type.'), { status: 404 });
}

/** Loads the event detail, always scoped to the workspace that triggered it. */
async function loadEvent(orgId: string, event: AlertEvent, workspaceName: string): Promise<BuiltAlert | null> {
  if (event.type === 'approval_requested') {
    const rows = await query(
      `SELECT ar.*, t.id AS task_id, t.title AS task_title, a.name AS agent_name, a.type AS agent_type
       FROM approval_requests ar
       JOIN tasks t ON t.id = ar.task_id
       JOIN agents a ON a.id = ar.agent_id
       WHERE ar.id = $1 AND t.org_id = $2`,
      [event.approvalId, orgId]
    );
    if (!rows.length) return null;
    const approval = rows[0];
    return {
      event: 'approval_requested',
      text: `Approval needed: ${approval.type}${approval.amount_usd ? ` ($${approval.amount_usd})` : ''} — ${approval.task_title}`,
      blocks: buildApprovalBlocks(approval, { title: approval.task_title }, { name: approval.agent_name, type: approval.agent_type }, { actions: false }),
      data: {
        approval_id: approval.id,
        task_id: approval.task_id,
        task_title: approval.task_title,
        type: approval.type,
        amount_usd: approval.amount_usd,
        context: approval.context,
        agent: { id: approval.agent_id, name: approval.agent_name, type: approval.agent_type },
        requested_at: approval.requested_at,
      },
    };
  }
  if (event.type === 'incident_created') {
    const rows = await query('SELECT * FROM incidents WHERE id=$1 AND org_id=$2', [event.incidentId, orgId]);
    if (!rows.length) return null;
    const incident = rows[0];
    return {
      event: 'incident_created',
      text: `${incident.severity} incident: ${incident.title}`,
      blocks: buildIncidentBlocks(incident, { name: workspaceName }),
      data: {
        incident_id: incident.id,
        severity: incident.severity,
        title: incident.title,
        description: incident.description,
        status: incident.status,
        agent_id: incident.agent_id,
        task_id: incident.task_id,
      },
    };
  }
  const counts = (await query(
    `SELECT (SELECT count(*)::int FROM tasks WHERE org_id=$1 AND status='halted') AS halted_tasks,
            (SELECT count(*)::int FROM agents WHERE org_id=$1 AND stop_requested_at IS NOT NULL AND COALESCE(capabilities->>'sample','false')<>'true') AS agents_notified,
            (SELECT count(*)::int FROM agents WHERE org_id=$1 AND stop_requested_at IS NOT NULL AND stop_acknowledged_at IS NOT NULL AND COALESCE(capabilities->>'sample','false')<>'true') AS agents_acknowledged`,
    [orgId]
  ))[0];
  const summary = { stopped_by: event.stoppedBy, halted_tasks: counts.halted_tasks, agents_notified: counts.agents_notified, agents_acknowledged: counts.agents_acknowledged };
  return {
    event: 'workspace_halted',
    text: `Workspace stopped by ${event.stoppedBy}`,
    blocks: buildHaltedBlocks(summary, { name: workspaceName }),
    data: summary,
  };
}

function buildBody(channel: any, alert: BuiltAlert, workspace: any, occurredAt: string) {
  const body = channel.kind === 'slack'
    ? JSON.stringify({ text: alert.text, blocks: alert.blocks })
    : JSON.stringify({ event: alert.event, occurred_at: occurredAt, workspace, data: alert.data });
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-AgentOnCall-Event': alert.event };
  if (channel.kind === 'webhook') headers['X-AgentOnCall-Signature'] = `sha256=${signBody(channel.secret, body)}`;
  return { body, headers };
}

async function deliver(channel: any, alert: BuiltAlert, workspace: any): Promise<DeliveryResult> {
  try {
    const host = new URL(channel.url).hostname.replace(/^\[|\]$/g, '');
    // The address check guards the real network. An injected transport is a test double.
    if (!transport) await assertDeliverableAddress(host);
    const { body, headers } = buildBody(channel, alert, workspace, new Date().toISOString());
    const send: AlertTransport = transport ?? (globalThis.fetch as unknown as AlertTransport);
    const response = await send(channel.url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status < 200 || response.status >= 300) return { kind: channel.kind, ok: false, status: response.status, error: `Destination responded with ${response.status}.` };
    return { kind: channel.kind, ok: true, status: response.status };
  } catch (error: any) {
    return { kind: channel.kind, ok: false, error: error?.message || 'Delivery failed.' };
  }
}

async function dispatch(orgId: string, event: AlertEvent): Promise<DeliveryResult[]> {
  const channels = await readDeliveryChannels(orgId);
  if (!channels.length) return [];
  const workspace = (await query('SELECT id, name FROM workspaces WHERE id=$1', [orgId]))[0];
  if (!workspace) return [];
  const alert = await loadEvent(orgId, event, workspace.name);
  if (!alert) return [];
  const results = await Promise.all(channels.map(channel => deliver(channel, alert, workspace)));
  for (const result of results) {
    if (!result.ok) console.error('[alerts]', event.type, orgId, result.kind, result.status ?? '-', result.error);
  }
  return results;
}

/**
 * Starts a delivery and returns its promise. Handlers call this as `void notify(...)`,
 * after their transaction has committed. It resolves rather than rejects, and never logs
 * the destination URL or the signing secret.
 */
export function notify(orgId: string, event: AlertEvent): Promise<DeliveryResult[]> {
  const run = dispatch(orgId, event)
    .catch((error: any) => { console.error('[alerts]', event.type, orgId, error?.message || 'Unexpected failure'); return []; })
    .finally(() => { inFlight.delete(run); });
  inFlight.add(run);
  return run;
}

/** Sends an operator-triggered test alert to every configured channel. */
export async function sendTest(orgId: string) {
  const channels = await readDeliveryChannels(orgId);
  if (!channels.length) throw Object.assign(new Error('Configure an alert channel first.'), { status: 409 });
  const workspace = (await query('SELECT id, name FROM workspaces WHERE id=$1', [orgId]))[0];
  const alert: BuiltAlert = {
    event: 'test',
    text: `Test alert from AgentOnCall for ${workspace.name}`,
    blocks: buildTestBlocks(workspace),
    data: { message: 'Test alert from AgentOnCall.' },
  };
  const delivered = await Promise.all(channels.map(channel => deliver(channel, alert, workspace)));
  return { ok: delivered.every(result => result.ok), delivered };
}
