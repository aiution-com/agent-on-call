# AgentOnCall

A workspace for connecting agents, queueing work, reviewing human approvals, and following task activity.

AgentOnCall is a cooperative control plane. Connected agents must ask for approval and check task and workspace status before external actions. It cannot stop an agent that ignores the API or undo an action already taken. Task policies and permissions are stored for future use; the current API does not enforce them.

To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md). To report a security issue, see [SECURITY.md](SECURITY.md).

Licensed under the [MIT License](LICENSE).

## Screenshots

These screens show a local demo workspace with fictional data.

**Workspace overview** — connected agents, recent tasks, pending approvals, and reported spend.

![AgentOnCall workspace overview with recent tasks and an approval inbox](docs/images/overview.jpg)

**Approval review** — the proposed action and its context before an operator decides.

![Pending staging deployment approval with action details and approve and reject controls](docs/images/approvals.jpg)

**Task activity** — progress, the approval pause, the operator decision, and completion.

![Task activity log showing review, approval, and completion](docs/images/task-activity.jpg)

## Quick start

With Docker installed:

```sh
docker compose up -d --build
```

Open `http://127.0.0.1:3000/signup`. Compose starts PostgreSQL, applies migrations,
and runs the app. These are development credentials; change them before making
an instance reachable from a network. See [docs/DEPLOY.md](docs/DEPLOY.md) for
deployment and backup instructions.

## Run with an existing local PostgreSQL database

```sh
npm ci
npm run migrate
npm run build
npm start
```

The API binds to `127.0.0.1:3000`. Open `http://127.0.0.1:3000/signup` to
create a profile and workspace. `HOST`, `PORT`, and `TRUST_PROXY` configure the
bind address and proxy behavior; see the deployment guide.

Configuration in `.env`:

```env
DATABASE_URL=postgresql://agentoncall:agentoncall@127.0.0.1:5432/agentoncall
PORT=3000
```

Migrations are transactional, recorded in `schema_migrations`, and can be rerun. Existing data is preserved. The application uses local PostgreSQL for profiles, password hashes, sessions, keys, tasks, approvals, incidents, and logs.

## Share through a tunnel

In a second terminal:

```sh
cloudflared tunnel --url http://127.0.0.1:3000 --no-autoupdate
```

Share the generated HTTPS URL. Keep the app, PostgreSQL, tunnel process, and computer running. Quick tunnel URLs change when recreated. The app trusts proxy headers only from loopback, requires matching browser origins for mutations, and sets Secure session cookies when accessed over HTTPS.

## Using it

If you are the person operating a workspace rather than building an integration, read **[docs/USER_GUIDE.md](docs/USER_GUIDE.md)** — what the words mean, how to review an approval, what a halted agent means, and honest answers to the questions people ask first. The same content is served by the app at **`/help`**, reachable without signing in.

## User flow

1. Create a profile with a name, email, password, and workspace name.
2. Enter the dashboard, which shows real workspace data and getting-started progress.
3. Open **Connect an agent**, create an agent key, and save it when shown.
4. Download the example worker from the connection guide and run it with Node.js 18+ using the generated commands.
5. Review its request in **Approvals**, then open **Tasks → Activity** to see the result.

The optional sample approval is explicitly marked as practice. It creates no external effects and runs no host commands. Settings lets users edit their profile/workspace, create or revoke agent keys, and stop their workspace.

## Authentication and access

- Passwords use scrypt with independent random salts.
- Session tokens are random, stored as SHA-256 hashes, expire after seven days, and use HttpOnly / SameSite cookies. Logging out revokes the session.
- Agent keys are shown once, stored hashed, and can be revoked immediately.
- Workspace identity comes from the session or key. A caller cannot select another workspace by supplying an organization ID.
- Every public record lookup and mutation is scoped to the authenticated workspace.
- Only signed-in operators can approve/reject actions, manage keys/profile, resolve incidents, or stop/reopen/restart work. Agent keys cannot approve their own actions.
- Signup/login have database-backed attempt limits. Responses use a restrictive CSP and do not cache private pages.

For this MVP, each account owns one workspace. Team invitations, verified email, self-service password recovery, MFA, and per-agent resource permissions are not implemented. Agent keys currently grant agent access across their own workspace.

## Agent integration

The dashboard provides a downloadable, dependency-free example at `/assets/agent-example.mjs`. Pass its environment explicitly:

```sh
AOC_API_URL='https://YOUR-TUNNEL.trycloudflare.com' \
AOC_API_KEY='YOUR_AGENT_KEY' \
node agent-example.mjs
```

REST calls use `Authorization: Bearer YOUR_AGENT_KEY`. The authenticated key selects the workspace; `orgId` is unnecessary. API endpoints include:

- `POST /api/v1/agents` — `{name,type,capabilities?}`
- `GET /api/v1/tasks?status=queued`
- `POST /api/v1/tasks/:id/claim` — `{agentId}`
- `PATCH /api/v1/tasks/:id/status` — `{status:"in_progress"}`
- `PATCH /api/v1/agents/:id/status` — `{status:"busy",healthScore?:100}`; also refreshes the heartbeat
- `POST /api/v1/tasks/:id/logs` — `{message,level?:"info"}`
- `POST /api/v1/tasks/:id/spend` — `{amountUsd}` (incremental reported spend)
- `POST /api/v1/approvals` — `{taskId,agentId,type,context,amountUsd?}`
- `GET /api/v1/approvals/:id` — poll the operator's decision
- `GET /api/v1/tasks/:id` and `GET /api/v1/emergency/status` — check before acting
- `PATCH /api/v1/tasks/:id/status` — `{status:"done"}` or `{status:"failed"}`

A task must be claimed before requesting approval. Requests pause the task; operators make the decision in the dashboard. Rejected tasks fail. Approval does not override a workspace stop.

## MCP

Build the project and configure the client to run the adapter. It calls the authenticated API and does not need database credentials:

```json
{
  "mcpServers": {
    "agentoncall": {
      "command": "node",
      "args": ["/absolute/path/to/agentoncall/dist/mcp/server.js"],
      "env": {
        "AOC_API_URL": "https://YOUR-TUNNEL.trycloudflare.com",
        "AOC_API_KEY": "YOUR_AGENT_KEY"
      }
    }
  }
}
```

The eight tools cover registering, listing tasks, claiming, reporting progress, requesting/checking approvals, completing, and checking agent status. `check_approval_status` returns `may_execute`, which includes the task and workspace state. Keep checking state before external actions.

The TypeScript `AgentGuard` SDK accepts `{apiUrl,apiKey,agentName}`. It creates/claims a task, waits for approval, checks stop status, calls the supplied action, and records completion. Action callbacks remain responsible for cooperation with stops during long-running work.

## Alerts

Each workspace can notify one Slack channel and one webhook of its own:

- `GET /api/v1/alerts` — configured destinations. The signing secret is never returned.
- `PUT /api/v1/alerts` — `{kind, url, secret?}` where `kind` is `slack` or `webhook`. An upsert.
  `secret` is required for `webhook` and must be 16–200 characters; Slack incoming webhooks
  cannot verify a signature, so Slack destinations have none. Leave `secret` out on an update
  to keep the stored one.
- `DELETE /api/v1/alerts?kind=slack` — remove a destination.
- `POST /api/v1/alerts` — send a test alert and report what happened.

All four require a signed-in operator. Agent keys are refused, so an agent cannot read its
workspace's destination or point the server somewhere new.

Alerts fire on an approval request, a new incident (from the API or the watchdog), and a
workspace stop. Operators can also configure this in **Settings** in the dashboard.

Webhook destinations receive:

```json
{
  "event": "approval_requested",
  "occurred_at": "2026-10-03T12:00:00.000Z",
  "workspace": { "id": "…", "name": "My workspace" },
  "data": { "…": "event-specific" }
}
```

Verify the `X-AgentOnCall-Signature` header, which is `sha256=<hex>` over the exact request
body, before trusting a payload:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
const expected = createHmac('sha256', process.env.SIGNING_SECRET).update(rawBody).digest('hex');
const received = req.headers['x-agentoncall-signature'].replace('sha256=', '');
const valid = received.length === expected.length && timingSafeEqual(Buffer.from(received), Buffer.from(expected));
```

Delivery is best effort. There are no retries, no delivery log, and no guarantee of arrival:
an alert is sent once, and a failure is logged on the server and dropped. It never blocks or
fails the request that triggered it. Destinations must use `https` and cannot point at a
private, loopback or link-local address, and redirects are refused. Because the destination
is resolved before connecting, a hostile DNS server that answers differently between the two
lookups can still reach an internal address; only an authenticated operator can supply a
destination in the first place.

## Stop and monitoring semantics

Stopping a workspace blocks new claims and marks active tasks halted. Reopening does not restart tasks automatically; operators restart them individually from Tasks. This is a cooperative stop signal, not remote process termination or reversal of an action already in flight.

The workspace watchdog checks active tasks every 20 seconds. Reported spend reaching a task's budget or an agent missing heartbeats for three minutes marks the task halted and creates an incident. It cannot prevent costs that are not reported or stop an external worker that ignores the signal.

Approvals are decided in the dashboard, and outbound alerts are per workspace
(see **Alerts**). Interactive Slack callbacks are not implemented, so
notifications are one-way.

## Validation

```sh
npm test
```

Tests use the configured local database and an ephemeral HTTP port, create isolated test workspaces, and clean up their records. They cover authentication, CSRF, workspace isolation, operator-only decisions, revocation, sample onboarding, task transitions, stop/restart behavior, budget monitoring, the downloadable worker, and the MCP adapter. They make no Slack, webhook or email calls: alert deliveries are replaced with a recorder in the tests.
