# Using AgentOnCall

A guide for the person *operating* a workspace — not for the person building the
integration. If you are writing the agent that connects, read
[the agent integration section of the README](../README.md#agent-integration)
instead.

The same content is served by the app itself at **`/help`**, which is where the
people who need it will actually be looking. When you change one, change both.

---

## What this is

Agents do work for you. AgentOnCall is the place they check in with you before
they do anything that matters — so a human decides, not the agent.

Every request an agent makes is recorded, every decision you make is recorded,
and nothing an agent asks for proceeds until you answer.

---

## The words we use

| Term | What it means |
|---|---|
| **Workspace** | Your private area. Nothing in it is visible to, or affected by, anyone else's workspace. |
| **Agent** | An AI agent or script you have connected, identified by its own key. |
| **Task** | One piece of work an agent is doing, with its own status and activity log. |
| **Approval** | An agent asking permission before it takes an action. Nothing proceeds until you answer. |
| **Incident** | A record that something went wrong — an agent went quiet, or a task hit its budget. |
| **Halted** | A task or agent that has been stopped on purpose. A well-behaved integration checks this and stops acting. |

---

## Three steps to your first approval

1. **Create your workspace.** It holds your agents, their tasks, and every
   decision you make about them.
2. **Connect an agent.** Create an agent key in **Connect an agent**, then either
   point your own agent at the API or run the example worker the dashboard offers
   for download. Each integration should have its own key.
3. **Review the request.** When your agent wants to act, it appears in
   **Approvals**. Approve and it continues; reject and the task stops.

---

## Reviewing an approval

Each waiting request shows what the agent wants to do and, importantly, what the
effect would be. That declaration is what you approve — not a blank yes.

- **Approve** lets the agent continue.
- **Reject** stops the task and marks it failed. The agent is told the answer.

Approving does **not** override a stopped workspace. If the workspace is stopped,
an approved task still waits until you reopen it.

---

## Connecting a real agent

Two ways in:

- **REST API** — send your key in the `Authorization` header on every request.
  The key selects your workspace, so you never pass an account id. The endpoint
  list is in the README.
- **MCP** — if your agent speaks the Model Context Protocol, point it at the
  adapter and the whole task lifecycle becomes tools it can call.

The workflow an agent follows: register → list queued tasks → claim → report
progress → request approval → check the decision → finish.

---

## When an agent goes quiet or overspends

AgentOnCall watches for two things: an agent that has stopped reporting in, and a
task that has spent more than the budget you set. In both cases the task is marked
**halted**, the agent is marked halted, and an incident is opened so there is a
record.

A halt is a **signal, not a kill switch**. It is the connected integration's job
to check the status before its next action and stop. When you build an
integration, read the task and workspace status before every external action.

---

## Alerts

In **Settings → Alerts** you can send notifications to one Slack channel or one
webhook of your own. They fire when:

- an agent asks for approval
- an incident is opened
- a workspace is stopped

Webhooks are signed with `X-AgentOnCall-Signature`, so your receiver can verify
the message came from us before trusting it. The signing secret is write-only —
it is never returned by the API.

**Delivery is best effort.** Each alert is sent once, never retried, and never
blocks the action that triggered it. Treat an alert as a prompt to check the
dashboard, not as a guaranteed record.

Alert URLs must be public `https` addresses. Internal, loopback and private
addresses are refused on purpose — the alert URL is a server-side request
forgery target if it is not constrained.

---

## Stopping everything

**Settings → Workspace controls → Stop workspace** halts the whole workspace.
New work cannot be claimed, active tasks are marked halted, and an incident is
recorded.

Reopening is a separate, deliberate step. Nothing resumes on its own, and each
task that was halted has to be restarted individually.

---

## Questions people actually ask

**I forgot my password. How do I reset it?**
You cannot, yet. There is no password reset, and no email is sent from this
product, so there is no self-service way back into an account. If you are locked
out, whoever runs your AgentOnCall instance has to help you directly.

**Can I invite a colleague?**
Not yet. One workspace currently has one operator, so there is no way to add a
second person or give someone a read-only view. If more than one person needs to
approve things, you will each need your own workspace for now.

**My agent says it cannot connect.**
Check three things in order: that the key is complete and has not been revoked,
that the workspace has not been stopped, and that the agent is pointed at the
right address. A stopped workspace refuses new work, which looks like a
connection problem from the agent's side.

**My agent ran, but I see nothing.**
Look in **Approvals** first — a request waiting for you does not appear anywhere
else. If it is not there, open **Tasks** and check that task's activity; a
rejected or failed task records why.

**My alert never arrived.**
Delivery is best effort and is never retried, so a single missed alert is
expected behaviour rather than a bug. Use **Send test alert** to check the
destination is right.

**Does this stop an agent that ignores you?**
No, and it is worth being clear about that. Everything here is cooperative: an
agent that never asks permission, or that ignores a halt, is not physically
prevented from acting. What you get is that well-behaved agents pause for you,
and that every request and every decision is recorded.

---

## What this platform does not do

Stated plainly so you are not surprised later:

- No password reset, and no email of any kind — no verification, no notifications
  by mail.
- One operator per workspace; no roles, no invitations.
- Enforcement is cooperative. An agent that ignores the API is not stopped by it.
- Alerts are best effort, with no retries and no delivery log.
- Notifications are one-way. Approvals happen in the dashboard, not in Slack.
