# AgentOnCall MVP status

Updated 2026-10-02. Repository: `/Users/shivam-mac/agentoncall`.

## Implemented

- Local PostgreSQL persistence with versioned, transactional migrations.
- Profile creation, workspace creation, login/logout, hashed passwords and sessions.
- Workspace-scoped REST API and operator/agent separation.
- Standard responsive dashboard: overview, agents, tasks, approvals, incidents, connection guide, settings.
- Getting-started progress derived from real workspace records.
- Operator-created tasks, activity logs, approval decisions, and incident resolution.
- One-time agent key reveal, key listing/revocation, and a downloadable example worker.
- MCP adapter and TypeScript SDK using the authenticated API.
- Workspace stop, explicit per-task restart, budget and heartbeat monitoring.
- Profile/workspace editing.
- Local server and HTTPS Cloudflare quick tunnel support.

The optional onboarding sample is marked as practice, scoped to the account, and has no external effects. Existing demo data is not copied into new accounts. Legacy shared Slack routes and host command execution are not exposed through the account API.

## Validated

- Build and local migrations.
- Integration tests: signup/login, browser-origin protection, session/key revocation, cross-workspace read/write denial, agent/operator permission boundaries, claims, approvals, stop/restart, sample completion, budget monitoring, example worker, and MCP.
- Desktop and phone dashboard layout; browser sign-in, task creation, sample approval, and connection instructions.

## Boundaries for the next iteration

- Accounts own one workspace; team membership/invitations are not implemented.
- Email verification, password recovery, and MFA require additional account flows.
- Agent keys are scoped to a workspace, not individual agents/resources.
- External adapters must honor stop signals; the server cannot kill arbitrary external processes.
- Agent cost figures are self-reported.
- Per-workspace outbound alerts (Slack or a signed webhook) are implemented. Slack OAuth installation and verified interactive callbacks are not: notifications are one-way, and approvals are decided in the dashboard.
- Stable hosting, automated database backups, and a permanent domain remain deployment work. The current preview requires the local computer, PostgreSQL, server, and tunnel to stay running.
