# Per-workspace alerting

Date: 2026-10-03
Status: approved for implementation planning

## Problem

Alerting was deliberately left out of the MVP. `src/slack.ts` posts to a single
process-wide webhook from `SLACK_WEBHOOK_URL`, so any notification would carry one
workspace's data to whoever configured that one URL. Nothing imports or mounts it:
`src/slack_routes.ts`, `src/simulation.ts` and the rest of the legacy modules are dead
code, and the README calls per-workspace Slack "a future integration".

Operators currently learn about a pending approval, a new incident, or a workspace halt
only by watching the dashboard. This adds per-workspace alert delivery, where the
destination belongs to the workspace and a notification can only ever reach the
workspace that owns it.

## Goals

- A workspace can configure its own alert destination.
- Approval requests, new incidents, and workspace halts notify that destination.
- An operator can send a test alert and find out whether their destination works.
- One workspace's events never reach another workspace's destination.

## Non-goals

- Inbound Slack interactions. Approvals stay in the dashboard, where only a signed-in
  operator can decide them. No endpoint accepts Slack callbacks.
- Message updates. Slack incoming webhooks cannot edit a message they posted, so a
  decision cannot be reflected back into an alert.
- Retries, delivery logs, or delivery guarantees. Delivery is best effort.
- Email or PagerDuty destinations. `kind` is `slack` or `webhook`.
- Slack OAuth installation. A user supplies their own incoming webhook URL.

## Schema

`migrations/004_alert_channels.sql`:

```sql
CREATE TABLE IF NOT EXISTS alert_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('slack', 'webhook')),
  url TEXT NOT NULL,
  secret TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind)
);

CREATE INDEX IF NOT EXISTS alert_channels_org_idx ON alert_channels(org_id);
```

`UNIQUE (org_id, kind)` makes one channel per kind a database fact rather than a
convention. The cascading foreign key matches `users` and `api_keys` in
`003_accounts.sql`, so deleting a workspace takes its channels with it.

`secret` is empty for Slack channels and holds the HMAC signing key for webhook
channels. It must also be registered in the migration list at `scripts/migrate.mjs:22`,
or the file is silently never applied.

No new environment variables. The leak being fixed was an environment variable; channel
configuration is per-workspace data. The legacy `SLACK_*` variables in `.env` are read
only by unmounted dead code and have no meaning on this path.

## Module layout

`buildApprovalBlocks()` and `buildDecisionBlocks()` move verbatim to a new
**`src/alert-blocks.ts`**: pure functions, no imports, no side effects, plus two new
builders (`buildIncidentBlocks`, `buildHaltedBlocks`). The move matters concretely —
importing `src/slack.ts` constructs a second `Pool` and loads `@slack/webhook` at module
load. `src/slack.ts` re-exports the two moved builders so the legacy modules still
compile unchanged.

New **`src/alerts.ts`** owns channel lookup, payload construction, signing, the
transport, `notify()`, and two testing seams.

## Event contract

```ts
export type AlertEvent =
  | { type: 'approval_requested'; approvalId: string }
  | { type: 'incident_created'; incidentId: string }
  | { type: 'workspace_halted'; stoppedBy: string };
```

Events carry **IDs, never rows**. `alerts.ts` loads the details it needs, and every query
is filtered by `org_id`. A cross-workspace read is not something the implementation has
to remember to avoid; it is not expressible. If the referenced row is gone by the time
the alert is built, `notify()` returns quietly.

## Payloads

`kind: 'slack'` sends the incoming-webhook shape:

```json
{ "text": "Approval needed: review — Update the deploy script", "blocks": [ ... ] }
```

`buildApprovalBlocks()` produces the `blocks` array for `approval_requested`.
`incident_created` and `workspace_halted` use the new builders. The test send uses a
`test` payload naming the workspace.

`kind: 'webhook'` sends:

```json
{
  "event": "approval_requested",
  "occurred_at": "2026-10-03T12:00:00.000Z",
  "workspace": { "id": "...", "name": "My workspace" },
  "data": { "...": "event-specific" }
}
```

`occurred_at` is the time the alert is built, not the time the underlying record was
created. `data` per event:

- `approval_requested` — `approval_id`, `task_id`, `task_title`, `type`, `amount_usd`,
  `context`, `agent: {id, name, type}`, `requested_at`
- `incident_created` — `incident_id`, `severity`, `title`, `description`, `status`,
  `agent_id`, `task_id`
- `workspace_halted` — `stopped_by`, `halted_tasks`, `halted_agents`
- `test` — `message`

## Signing

Every delivery carries `Content-Type: application/json` and `X-AgentOnCall-Event: <event>`.
Webhook deliveries additionally carry:

- `X-AgentOnCall-Signature: sha256=<hex>` — HMAC-SHA256 of the exact serialized request
  body bytes, keyed with the channel secret

Slack deliveries carry no signature. Slack incoming webhooks do not verify a signature,
and prompting a user for a "secret" on a Slack channel invites them to paste Slack's app
signing secret — a credential for verifying *inbound* requests — into a third-party
database. So `secret` is required for `kind: 'webhook'` and empty for `kind: 'slack'`,
and the dashboard hides the field when Slack is selected.

## Delivery semantics

- Routes call `void notify(org, event)` **after** their transaction commits. No network
  I/O happens inside a transaction; the existing boundaries use `FOR UPDATE` /
  `FOR SHARE` and are deliberate.
- `notify()` resolves, never rejects. It catches everything, including programming
  errors, so a floating promise cannot become an unhandled rejection.
- 5 second timeout via `AbortSignal.timeout(5000)`, and `redirect: 'error'` so a public
  URL cannot redirect into an internal address.
- Non-2xx responses are logged and dropped. **No retries.** Nothing in the product
  depends on an alert arriving, and a failed alert can never affect the request that
  triggered it.
- Zero configured channels is a silent no-op, which keeps the existing test suite free
  of outbound calls.
- Log lines are prefixed `[alerts]` and contain the event type, org id and status only.
  Never the URL or the secret.

`alerts.ts` exports `flushAlerts()` (awaits in-flight sends) and `setAlertTransport()`
(installs a recorder) as testing seams. The default transport is `fetch`.

## Endpoints

All four live on `workspaceApi` under `/api/v1`, inheriting the existing `requireUser`
gate and the `orgId` forgery check, and all four use `requireSession`. An agent key gets
403 — an agent must not be able to read its workspace's webhook URL out, nor point the
server at a URL of its choosing.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/v1/alerts` | `{channels: [{kind, url, updated_at}]}`. **`secret` is omitted entirely**, matching how `GET /api/v1/keys` omits `token`. |
| `PUT` | `/api/v1/alerts` | `{kind, url, secret?}`. Upsert on `(org_id, kind)`. Returns 200 `{ok: true, kind, url, updated_at}`. |
| `DELETE` | `/api/v1/alerts?kind=slack` | 200 `{ok: true}`; 400 for a kind outside the two valid values, 404 if that kind is not configured. |
| `POST` | `/api/v1/alerts` | Test send. 409 `{error: 'Configure an alert channel first.'}` when nothing is configured. |

`secret` is required when creating a webhook channel and optional when updating one; a
blank or absent value on update keeps the stored secret. Without that, correcting a typo
in a URL would mean re-pasting the signing key.

The test send returns 200 `{ok, delivered: [{kind, ok, status?, error?}]}` where `ok` is
true only if every delivery succeeded. A rejected delivery is `ok: false` with the status,
**not** a 500: "your webhook URL is wrong" is a normal expected answer to a test send, and
this is the only place a delivery failure ever reaches a human.

### URL validation

On write:

- string, trimmed, at most 1000 characters, parseable by `new URL`
- `https:` only
- no embedded credentials (`https://user:pass@host/`) — rejected
- hostname must not be `localhost` or end in `.localhost`
- hostname must not be an IP literal in a loopback, private, link-local, multicast,
  unspecified, or carrier-grade-NAT range
- the normalized `url.href` is what gets stored

Secret length is 16 to 200 characters when required.

On send, the hostname is resolved and the delivery is refused if **any** resolved address
falls in one of those ranges. This closes the class of bypass the write-time literal check
alone misses, such as `https://169.254.169.254.nip.io/`.

Known limitation, to be stated in the README rather than hidden: `fetch` cannot pin the
address it resolves, so a hostile authoritative DNS server that answers differently
between our check and the connection can still win the race. Redirects are refused and
the URL can only be supplied by an authenticated operator, which bounds the exposure.
Closing it fully needs a custom agent that connects to the checked address.

## Firing sites

Four call sites, all after commit:

1. `src/workspace-api.ts:110` — `POST /api/v1/approvals`, after the transaction that ends
   at line 119 → `approval_requested` with `result.id`, scoped with the route's `org`.
2. `src/workspace-api.ts:136` — `POST /api/v1/incidents`. The handler becomes a few
   statements instead of the single expression at line 140 so the inserted row can be
   captured; the response shape is unchanged → `incident_created`.
3. `src/workspace-api.ts:145` — `POST /api/v1/emergency/stop`, after the transaction that
   ends at line 153 → both `incident_created` (for the critical incident it inserts) and
   `workspace_halted`. Two alerts on one action is intentional: the spec lists both
   conditions, and silently withholding the incident notification would be surprising.
4. `src/workspace-watchdog.ts:4` — `inspectWorkspace()` collects the ids of the incidents
   it inserts inside the transaction, then notifies for each after it commits.
   **The return value stays `candidates.rowCount`** — `tests/onboarding.mjs:97` asserts
   `1` then `0`.

`POST /api/v1/onboarding/sample` is deliberately **not** hooked. It is marked as practice,
the test suite asserts it has no external effects, and its approval is inserted with raw
SQL at `src/workspace-api.ts:169`, so it is already bypassed.

There is no `approval_decided` event, so `buildDecisionBlocks()` moves but keeps zero call
sites. It builds a *replacement* for an already-posted Slack message, which an incoming
webhook cannot do.

## Dashboard

`public/dashboard.html` needs no change: the panel is rendered by JavaScript into `#page`
as a card inside the existing `settings` view (`public/assets/dashboard.js:51`).

- Configured: kind badge, the URL in `mono` and escaped, **Send test alert** and
  **Remove channel** buttons, URL field prefilled, secret field empty.
- Not configured: hint, kind `select` (Slack / Webhook), URL field, secret
  `type="password"` field shown only for Webhook, **Save channel**.
- The secret is never rendered. `GET` omits it, so the field is never prefilled, and it is
  cleared after a save. Interpolated values go through the existing `escapeHTML`.
- Plumbing follows the file's existing conventions: `/v1/alerts` joins the `Promise.all`
  in `refresh()`; saving is a form submit registered alongside `taskForm` / `keyForm` /
  `profileForm` at line 64; test and remove are cases in `action()` at line 58 reached
  through the delegated `data-action` handler. Handlers must stay delegated — the CSP is
  `script-src 'self'`, so inline handlers would not run.
- The settings view does not re-render on background refresh, so every mutation does
  `await refresh(true)` followed by a `toast()`, as `stop` and `resume` already do.
- Three mechanical CSS edits add `select` to the existing `input,textarea` and
  `.field input,.field textarea` rules in `public/assets/app.css`. `select` is currently
  unstyled (zero occurrences), and `.field input` is type-agnostic, so the password field
  inherits its styling.

`npm test` drives HTTP and not the DOM, so the panel itself is verified by hand. The
contract it depends on is covered: `GET` omits the secret, a blank secret preserves the
stored one, an unconfigured test send is 409, and a rejected delivery is 200 with
`ok: false`.

## Testing

New `tests/alerts.mjs`, self-contained with its own small request helper rather than
refactoring the passing `tests/onboarding.mjs`. `setAlertTransport()` installs a recorder,
so the suite is deterministic and makes no outbound calls — consistent with the README's
existing promise, and `flushAlerts()` removes polling.

1. Channel lifecycle and isolation: configure, read back with `secret === undefined`,
   second workspace sees nothing, cannot delete the first workspace's channel (404), and
   an agent key gets 403 on all four methods.
2. Validation: `http://` rejected, `kind: 'sms'` rejected, short secret rejected for
   webhook, credentials-in-URL rejected, IP literals in loopback and private ranges
   rejected, and a Slack channel with no secret accepted.
3. Secret preservation: update a URL with no secret and the original signature key is
   still used by the next delivery.
4. Test send: exactly one delivery, `X-AgentOnCall-Event: test`, and the HMAC recomputed
   independently in the test from the exact body matches the header.
5. `approval_requested` fires once, and the Slack blocks contain the task title and the
   approval id.
6. `incident_created` fires from `POST /api/v1/incidents`.
7. `workspace_halted` and `incident_created` both fire from `POST /api/v1/emergency/stop`.
8. `inspectWorkspace()` fires `incident_created` and still returns `1` then `0`.
9. **Cross-workspace regression:** the first workspace has a channel, the second does not.
   The second creates an approval, an incident, and a halt. The recorder sees zero
   deliveries. This is the test for the original defect.
10. No channel configured: no delivery, no error, and the request still succeeds.
11. Failure isolation: a transport that throws, and one that returns 500, leave the
    originating request returning its normal success status.

## Documentation

- README gains an Alerts section: the four endpoints, the events, the signature scheme
  with a receiver-side verification example, the https-only and private-address guards,
  best-effort delivery with no retries and no delivery log, and the DNS-rebinding
  limitation. The line describing per-workspace Slack as "a future integration" is
  updated to describe what now ships.
- `docs/AGENT_ONCALL_BUILD_PLAN.md:34` is adjusted to note that outbound alerts exist
  while interactive callbacks remain out of scope.

## Files touched

New: `migrations/004_alert_channels.sql`, `src/alert-blocks.ts`, `src/alerts.ts`,
`tests/alerts.mjs`, this spec.

Modified: `src/slack.ts`, `src/workspace-api.ts`, `src/workspace-watchdog.ts`,
`scripts/migrate.mjs`, `public/assets/dashboard.js`, `public/assets/app.css`,
`README.md`, `docs/AGENT_ONCALL_BUILD_PLAN.md`.
