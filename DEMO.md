# Running the demo

Everything below runs on your own machine against your local Postgres. No
deployment, no hosting, no external accounts.

Credentials for the prepared account are in `DEMO-CREDENTIALS.local.md`
(git-ignored — it is deliberately not in this file).

---

## Step 0 — do this once, before the meeting

**Replace the alert destination.** The workspace currently points at a
`webhook.site` URL I created during rehearsal. That one may expire, and it is
public. Make your own:

1. Open <https://webhook.site> in a browser tab and leave it open. It
   immediately shows **Your unique URL**, something like
   `https://webhook.site/9f3c...`.
2. In the dashboard go to **Settings → Alerts**, paste that URL into **URL**,
   pick **My own webhook (signed)**, and type any signing secret of 16+
   characters.
3. Click **Save destination**, then **Send test alert**. The request should
   appear in your webhook.site tab within a second, with an
   `x-agentoncall-signature` header.

Keep that webhook.site tab open during the demo — it is the payoff for the
alerting beat.

**Then dry-run the whole thing once** (Section 2 below), reset, and stop.

---

## 1 — Start it

Three commands, in this order:

```bash
npm run migrate
```

```bash
npm run build
```

```bash
npm start
```

`npm start` prints `AgentOnCall listening on 127.0.0.1:3000` and stays in the
foreground. Leave that terminal tab alone for the rest of the demo — that is
the server.

### Use `127.0.0.1`, never `localhost`

This is not a style preference. Your portfolio dev server
(`~/shivam.portfolio`) also listens on port 3000, on the IPv6 wildcard, while
AgentOnCall binds IPv4 loopback. Both bind successfully and neither reports a
conflict, but they answer different names:

| Address | Serves |
|---|---|
| `http://127.0.0.1:3000` | AgentOnCall |
| `http://localhost:3000` | your portfolio site |

`localhost` resolves to `::1` first on this machine, so opening
`http://localhost:3000` during the demo would show your portfolio to the room
instead of AgentOnCall. **Always use `http://127.0.0.1:3000`.**

Confirm before you present — this must print `{"ok":true}`:

```bash
curl -s http://127.0.0.1:3000/health
```

If it does not, either AgentOnCall is not running or something else took the
IPv4 socket. If `npm start` prints `EADDRINUSE`, a server from an earlier
session still holds port 3000:

```bash
lsof -tnP -iTCP:3000 -sTCP:LISTEN | xargs kill
```

Do not run that blindly — if your portfolio server is the thing holding the
port, killing it is not what you want. Check with
`lsof -p <pid> | grep cwd` first.

Then open <http://127.0.0.1:3000>. If you signed in during rehearsal you go
straight to the dashboard; otherwise use **Sign in** with the credentials from
`DEMO-CREDENTIALS.local.md`.

**Check Postgres is running first.** If `npm run migrate` cannot connect, the
database is down — start it and retry.

---

## 2 — The demo script

About six minutes at a relaxed pace. The order matters: it builds from "what is
this" to "watch it actually work".

### Beat 1 — Overview (30s)

You land on **Overview**. Point at the four numbers: connected agents, active
tasks, awaiting approval, reported spend.

> "This is the control plane for agents that take real actions. Every number
> here is scoped to one workspace. Nothing an agent does can be seen by, or
> affect, any other workspace — that isolation is enforced in the database, not
> in the UI."

### Beat 2 — Configure alerting (60s)

**Settings → Alerts.** Point at the card.

> "You get told about the things that need a human: an approval request, a new
> incident, or a workspace being stopped. One Slack channel and one webhook per
> workspace."

Click **Send test alert** and switch to the webhook.site tab.

> "There it is — the payload, and this header: `x-agentoncall-signature`, an
> HMAC-SHA256 over the exact body. Your receiver verifies that before trusting
> anything. So the notification is authenticated, and it carries only this
> workspace's data."

If they ask about the secret: it is write-only. `GET /api/v1/alerts` never
returns it, and it is never logged.

### Beat 3 — Connect a real agent (90s)

**Connect an agent.** Three numbered steps are on the page; follow them.

1. Click **Create agent key**. Name it whatever. The key is shown once — copy
   it.
2. Download the example worker, or use the one at `public/assets/agent-example.mjs`
   that is already in the repo.
3. Run it in a terminal, pasting your key:

```bash
AOC_API_URL='http://127.0.0.1:3000' AOC_API_KEY='PASTE_YOUR_KEY' node public/assets/agent-example.mjs
```

It prints `Connected. Open http://127.0.0.1:3000/dashboard#approvals and review
the request.` and then **blocks**.

> "The agent has stopped and is waiting. It will not take the action until a
> human says yes."

### Beat 4 — Approve it (60s)

**Approvals** — the request is sitting there with its proposed action and
effect spelled out.

> "The agent has to declare what it wants to do and what the effect is. That
> declaration is what the human approves — not a blank yes."

Check the webhook.site tab: an `approval_requested` event arrived the moment
the agent asked, unprompted by any click. **This is the strongest moment in the
demo** — the alert came from real product activity, not from the test button.

Now click **Approve**. Switch to the worker terminal.

> "It resumed and finished."

### Beat 5 — The audit trail (30s)

**Tasks** → the task is `done` → **Activity**.

> "Every step the agent took is logged, with the human decision in the same
> timeline. In an incident, this is the record."

### Beat 6 — The stop, if you have time (45s)

**Settings → Workspace controls → Stop workspace.**

> "One operator action halts the whole workspace. New work cannot be claimed,
> active tasks are marked halted, and any well-behaved integration checks that
> status before its next external action. Reopening is a separate, deliberate
> step."

Then **Resume**. Do not leave the workspace halted.

---

## 3 — Reset between rehearsals

Any time you want the workspace back to empty-with-a-connected-state:

```bash
node scripts/demo-reset.mjs
```

It deletes the agents, tasks, approvals, incidents and logs for the demo
account and **keeps** the account, the login session, and the alert
destination — so the Alerts card still looks configured. It prints what it
deleted. It refuses to run if `DATABASE_URL` points anywhere that is not
localhost.

Restart the server afterwards so the dashboard reloads clean.

If a rehearsal goes badly wrong, you can wipe the whole account and start over
by signing up again from the welcome page. The `demo-reset.mjs --wipe-alerts`
flag also clears the configured destination.

---

## 4 — What to say if they push on limits

Be straight with them. These are the real edges, and knowing them is better
than being caught out:

- **Delivery is best effort.** Alerts are sent once. No retries, no delivery
  log, no guarantee. A failed delivery is logged on the server and dropped, and
  it never fails the request that triggered it. That is a deliberate trade — an
  approval request must not fail because a webhook was down.
- **Slack is one-way today.** We send notifications to Slack. Approving *from*
  Slack needs OAuth installation and interactive callbacks, which are not
  built. Approvals happen in the dashboard.
- **One operator per workspace.** There is no role model yet — no "approver vs
  viewer", no approval chains beyond what the schema allows.
- **Destinations must be public HTTPS.** The URL guard refuses `http`, and
  refuses loopback, private and link-local addresses, so you cannot point it at
  something on your own laptop. That is on purpose: the alert URL is a
  server-side request forgery target if it is not constrained.
- **This is a local single-tenant instance.** Running it for a real customer
  means the deployment story, backups, and multi-tenancy hardening — none of
  which is done. It is a working product, not a hosted service.

The thing to be confident about: **the workspace isolation is real.** It is
enforced by an `org_id` filter on every query in the alerting path and by the
schema, not by UI convention. If they are evaluating whether this is
trustworthy enough to put in front of an agent that can spend money, that is
the answer to give.
