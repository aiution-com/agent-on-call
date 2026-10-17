# AgentOnCall

**The operations layer for always-on AI agents.**

AgentOnCall is a cooperative control plane for AI agents. Connected agents can record work, request human approval, and check whether a task or workspace has been stopped before taking an external action.

You run it. Your agents check in with it. You stay in charge.

---

## The problem it solves

Agents are getting more capable and more autonomous — and more dangerous as a result. Today, if you give an agent the ability to act (make purchases, send things, touch systems), you're trusting it to behave, with no record of what it decided and no way to intervene.

AgentOnCall gives integrated agents a simple workflow: **check in, ask before an external action, and honor the answer.**

- Integrated agents can wait for a human answer before an action.
- Requests and decisions made through AgentOnCall are recorded.
- You can signal all connected agents to stop from one place.

---

## What it does

When an integrated agent wants to take an action, it opens a **task**, reports its progress, and raises an **approval request** — a declaration of what it wants to do and what the effect would be. That request lands in your dashboard (and optionally your Slack), where you **approve** it — the agent continues — or **reject** it — the task stops.

While an agent works, AgentOnCall watches for two things: an agent that has **gone quiet** (stopped reporting in) and a task whose **reported spend reached its budget**. In both cases the task and agent are marked **halted** and an **incident** is opened. Unreported spending cannot be detected.

And if things go sideways, **Stop workspace** blocks new claims, marks active tasks halted, and records an incident. Connected agents must honor the stop signal. Reopening is a deliberate step — halted tasks do not restart on their own.

---

## Key features

| Feature | What it gives you |
|---|---|
| **Approvals** | A human decides on requests submitted through the API. Each request states what the agent wants to do and its effect. The integration must wait for the decision. |
| **Activity log** | Requests, progress reports, and decisions submitted through AgentOnCall are visible per task. |
| **Connect in minutes** | Point any agent at the service with just a **URL + API key**. Works via MCP (Claude Code, Cursor, and any MCP-compatible agent), a plain REST API, or a small SDK. |
| **Incident records** | An agent goes quiet or a task hits its budget → automatic halt + an incident you can read later. |
| **Reported budget limits** | Set a task budget; reaching it with reported spend triggers a halt signal. |
| **Stop workspace** | One click blocks new claims and marks active tasks halted. Integrated agents must honor the signal. |
| **Alerts** | Optional Slack channel or signed webhook fired when an approval is requested, an incident opens, or the workspace is stopped. |
| **Isolated workspaces** | Your workspace is private. Nothing in it is visible to or affected by anyone else's workspace. |

---

## How it helps

**For people running agents in production** — you stop flying blind. When an agent does something, you know what it did, why, and whether you said yes. When something goes wrong, you have a timeline instead of a shrug.

**For teams evaluating autonomy** — you can observe integrated agents and require them to request approval before external actions. Decisions are recorded, but an action already taken cannot necessarily be reversed. The current policy records are not enforced by the API.

**For the agents themselves** — integration is deliberately small. One API key, one URL, and the agent gets the whole lifecycle: register → list tasks → claim → report progress → request approval → check decision → finish. For MCP-compatible agents, that whole lifecycle becomes a set of tools the agent can call.

**The honest part** — AgentOnCall is a cooperative layer, not a sandbox. An agent that ignores the API is not physically stopped by it, and actions it takes outside the API are not recorded here. Integrated agents can pause and ask, leaving a record of their requests and your decisions.

---

## How it works (one minute)

1. **Create your workspace** — it holds your agents, tasks, and every decision you make.
2. **Connect an agent** — create an agent key, then give your agent the URL + key. That's the whole integration.
3. **Review requests** — when an agent wants to act, it appears in **Approvals**. Approve and it continues; reject and the task stops. The agent is told your answer either way.

That's the loop. Everything else — incidents, budgets, alerts, halt state — runs automatically around it.

---

## What it's not

So you're not surprised later:

- It's not a sandbox — enforcement is cooperative, as above.
- No email of any kind — no verification, no password reset, no mail notifications.
- One operator per workspace today — no roles or invitations.
- Alerts are best-effort — one attempt, no retries. Treat them as a "look at the dashboard" nudge, not a delivery guarantee.

---

## Try it

Sign up, create a workspace, connect an agent, and watch your first approval appear. The dashboard's **Connect an agent** page walks through the whole flow, and `/help` (on the running instance) mirrors this guide.

**A place for connected agents to ask, and for you to decide.**
