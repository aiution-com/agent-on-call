# Per-workspace alerting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each workspace its own alert destination, notify it on approval requests, new incidents and workspace stops, and let an operator send a test alert to confirm the destination works.

**Architecture:** A new `alert_channels` table holds one destination per `(org_id, kind)`. A new `src/alerts.ts` builds and sends alerts on a discardable, never-rejecting promise, called from four sites after their transactions commit. Events carry IDs, never rows, and every lookup in `alerts.ts` filters by `org_id`, so one workspace's event cannot be built from another's data. The pure Slack block builders move out of `src/slack.ts` into a side-effect-free module so the alerting path never loads a database pool or the Slack webhook client.

**Tech Stack:** TypeScript (CommonJS, `strict`), Express 5, `pg`, `node:test` with `.mjs` test files, PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-10-03-per-workspace-alerting-design.md`

## Global Constraints

- `tsconfig.json` has `"strict": true`. Every new `.ts` file must typecheck with no errors under `npm run typecheck`.
- Module system is CommonJS. Tests use `createRequire(import.meta.url)` and `require('../dist/...')`, so **`npm run build` must run before any test**.
- `npm test` is `npm run build && node --test tests/*.mjs`. A single file is `npm run build && node --test tests/alerts.mjs`.
- Migrations do **not** run automatically. `npm run migrate` must be run by hand after Task 1, and the migration filename must be added to the array at `scripts/migrate.mjs:22` or it is silently skipped forever.
- Match the surrounding code style: dense single-expression handlers in `src/workspace-api.ts` and `public/assets/dashboard.js`, spaced blocks in `src/db.ts` and `migrations/*.sql`. Follow the file you are editing.
- The channel `secret` is never returned by any endpoint, never logged, and never interpolated into a response body.
- **No new environment variables.** Channel configuration is per-workspace data. The legacy `SLACK_*` variables are read only by unmounted dead code and are not used by any of this.
- The test suite must make **no outbound network calls**. All alert sending in tests goes through `setAlertTransport()`, which is injected at the top of `tests/alerts.mjs`.
- Do not touch `tests/onboarding.mjs`. It is green and its `inspectWorkspace` assertions are a regression guard for Task 7.

---

### Task 1: `alert_channels` migration

**Files:**
- Create: `migrations/004_alert_channels.sql`
- Modify: `scripts/migrate.mjs:22`
- Test: `tests/alerts.mjs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: the `alert_channels` table with columns `id`, `org_id`, `kind`, `url`, `secret`, `created_at`, `updated_at`; a `UNIQUE (org_id, kind)` constraint; and a cascading foreign key to `workspaces(id)`. Later tasks read and write these columns by name.

- [ ] **Step 1: Write the failing test**

Create `tests/alerts.mjs`. This is the whole harness for the rest of the plan — later tasks add `t.test(...)` blocks inside the same `try` and add helpers beside these ones. It grows with the plan: this step creates only what Task 1 needs, and Task 4's first step adds the alerting helpers.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require=createRequire(import.meta.url);
const {app}=require('../dist/index.js');
const {pool}=require('../dist/db.js');
const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const created=[];
async function request(path,{method='GET',body,cookie,key,origin=base}={}){
  const response=await fetch(base+path,{method,redirect:'manual',headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(key?{Authorization:`Bearer ${key}`}:{ }),...(origin?{Origin:origin}:{})},body:body?JSON.stringify(body):undefined});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
}
async function signup(label){const email=`aoc-alert-${randomUUID()}@example.test`, password='test-password-84!';const r=await request('/api/auth/signup',{method:'POST',body:{name:label,workspace:label+' workspace',email,password}});assert.equal(r.status,201);const me=await request('/api/auth/me',{cookie:r.cookie});created.push(me.data.org_id);return {cookie:r.cookie,profile:me.data,email,password};}
try{
 await test('per-workspace alerts',async t=>{
  await t.test('the alert_channels table enforces one channel per kind and cascades with its workspace',async()=>{
   const org=(await pool.query("INSERT INTO workspaces(name) VALUES('Alert schema test') RETURNING id")).rows[0].id;
   created.push(org);
   await pool.query("INSERT INTO alert_channels(org_id,kind,url,secret) VALUES($1,'slack','https://example.test/one','')",[org]);
   await assert.rejects(
    pool.query("INSERT INTO alert_channels(org_id,kind,url,secret) VALUES($1,'slack','https://example.test/two','')",[org]),
    error=>error.code==='23505'
   );
   await assert.rejects(
    pool.query("INSERT INTO alert_channels(org_id,kind,url,secret) VALUES($1,'sms','https://example.test/three','')",[org]),
    error=>error.code==='23514'
   );
   const throwaway=(await pool.query("INSERT INTO workspaces(name) VALUES('Alert cascade test') RETURNING id")).rows[0].id;
   await pool.query("INSERT INTO alert_channels(org_id,kind,url,secret) VALUES($1,'webhook','https://example.test/four','secret-value-1234')",[throwaway]);
   await pool.query('DELETE FROM workspaces WHERE id=$1',[throwaway]);
   assert.equal((await pool.query('SELECT 1 FROM alert_channels WHERE org_id=$1',[throwaway])).rowCount,0);
  });
 });
}finally{
 for(const org of created){await pool.query('DELETE FROM approval_requests WHERE task_id IN(SELECT id FROM tasks WHERE org_id=$1)',[org]);await pool.query('DELETE FROM incidents WHERE org_id=$1',[org]);await pool.query('DELETE FROM tasks WHERE org_id=$1',[org]);await pool.query('DELETE FROM agents WHERE org_id=$1',[org]);await pool.query('DELETE FROM policies WHERE org_id=$1',[org]);await pool.query('DELETE FROM workspaces WHERE id=$1',[org]);}
 await pool.query("DELETE FROM auth_limits WHERE key=$1",[require('../dist/auth.js').digest('127.0.0.1')]);
 await new Promise(resolve=>server.close(resolve));await pool.end();
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test tests/alerts.mjs`
Expected: FAIL — `relation "alert_channels" does not exist`. The migration file does not exist yet and is not registered, so `npm run migrate` at this point is a no-op on the old list; run it anyway to confirm it reports only the three existing files.

- [ ] **Step 3: Write the migration**

Create `migrations/004_alert_channels.sql`:

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

- [ ] **Step 4: Register the migration**

In `scripts/migrate.mjs:22`, add the filename to the end of the array:

```js
    for (const name of ['001_initial_schema.sql', '002_task_logs.sql', '003_accounts.sql', '004_alert_channels.sql']) {
```

- [ ] **Step 5: Apply the migration and verify the table exists**

Run: `npm run migrate`
Expected: output includes `applied 004_alert_channels.sql`.

Run: `node -e "const{pool}=require('./dist/db.js');pool.query('SELECT column_name,data_type FROM information_schema.columns WHERE table_name=$$alert_channels$$ ORDER BY ordinal_position').then(r=>{console.log(r.rows);return pool.end();})"`
Expected: seven rows, in this order — `id`, `org_id`, `kind`, `url`, `secret`, `created_at`, `updated_at`. An empty array means Step 4 was not applied.

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test tests/alerts.mjs`
Expected: PASS. The schema test is the only block in the file at this point, and it asserts all three constraints: the unique `(org_id, kind)` pair, the `kind` check, and the cascade on workspace delete.

- [ ] **Step 7: Commit**

```bash
git add migrations/004_alert_channels.sql scripts/migrate.mjs tests/alerts.mjs
git commit -m "Add alert_channels table and its migration registration"
```

---

### Task 2: Pure block builders in `src/alert-blocks.ts`

**Files:**
- Create: `src/alert-blocks.ts`
- Modify: `src/slack.ts` (remove the two moved functions, re-export them)
- Test: `tests/alerts.mjs`

**Interfaces:**
- Consumes: nothing. This module must have **zero imports** — that is the point of the move, and Task 2's third test enforces it.
- Produces:
  - `buildApprovalBlocks(approval: any, task: any, agent: any, options?: { actions?: boolean }): any[]`
  - `buildDecisionBlocks(approvalId: string, decision: string, decidedBy: string, originalBlocks: any[]): any[]`
  - `buildIncidentBlocks(incident: any, workspace: any): any[]`
  - `buildHaltedBlocks(summary: any, workspace: any): any[]`
  - `buildTestBlocks(workspace: any): any[]`

  Task 4 calls `buildApprovalBlocks(..., { actions: false })` and the other three builders.

**One deliberate change from the spec:** the spec says the two builders move *verbatim*. `buildApprovalBlocks` instead gains one **additive optional fourth parameter**, `options.actions`, defaulting to `true`. Reason: the actions block it returns is Approve/Reject buttons, and this feature deliberately has no inbound endpoint, so an alert carrying those buttons would render live buttons that silently do nothing when a user clicks them. With the parameter appended and defaulting to `true`, the legacy call in `src/slack.ts` is unchanged, so nothing else breaks. When actions are omitted the builder appends a context block telling the reader to decide in the dashboard.

- [ ] **Step 1: Write the failing tests**

Add this block inside the `try` in `tests/alerts.mjs`, after the Task 1 `t.test` block:

```js
  await t.test('block builders are pure and the alert path does not load a database pool',async()=>{
   const {buildApprovalBlocks,buildDecisionBlocks,buildIncidentBlocks,buildHaltedBlocks,buildTestBlocks}=require('../dist/alert-blocks.js');
   const approval={id:'11111111-1111-1111-1111-111111111111',type:'review',amount_usd:null,context:{action:'Check result'},requested_at:'2026-10-03T10:00:00.000Z'};
   const task={title:'Review the latest pull request'};
   const agent={name:'Connected worker',type:'test'};
   const withActions=buildApprovalBlocks(approval,task,agent);
   assert.equal(withActions.at(-1).type,'actions');
   assert.equal(withActions.at(-1).elements.length,2);
   const withoutActions=buildApprovalBlocks(approval,task,agent,{actions:false});
   assert.equal(withoutActions.some(b=>b.type==='actions'),false);
   assert.equal(withoutActions.at(-1).type,'context');
   assert.match(JSON.stringify(withoutActions),/Review the latest pull request/);
   assert.match(JSON.stringify(withoutActions),/11111111-1111-1111-1111-111111111111/);
   assert.match(JSON.stringify(withoutActions),/in your AgentOnCall dashboard/);
   const decided=buildDecisionBlocks(approval.id,'approved','Alice',withActions);
   assert.equal(decided.some(b=>b.type==='actions'),false);
   assert.match(JSON.stringify(decided),/Approved by Alice/);
   assert.match(JSON.stringify(buildIncidentBlocks({id:'x',title:'Budget limit reached',description:'Spend reached the limit.',severity:'high'},{name:'My workspace'})),/\*Budget limit reached\*/);
   assert.match(JSON.stringify(buildHaltedBlocks({stopped_by:'Alice',halted_tasks:2,halted_agents:1},{name:'My workspace'})),/2 task\(s\) and 1 agent\(s\)/);
   assert.match(JSON.stringify(buildTestBlocks({name:'My workspace'})),/Test alert/);
  });
  await t.test('importing the block builders loads no dependencies',async()=>{
   const {execFileSync}=await import('node:child_process');
   const target=JSON.stringify(require.resolve('../dist/alert-blocks.js'));
   const probe=execFileSync(process.execPath,['-e',`require(${target});const external=Object.keys(require.cache).filter(k=>k.includes('node_modules'));console.log(JSON.stringify(external));`],{encoding:'utf8'});
   assert.deepEqual(JSON.parse(probe),[]);
  });
```

The second test spawns a fresh Node process and asserts that requiring the builders pulls in nothing from `node_modules` — no `pg`, no `@slack/webhook`. That is the property that makes the alerting path safe to import from `alerts.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && node --test tests/alerts.mjs`
Expected: FAIL — `Cannot find module '../dist/alert-blocks.js'`.

- [ ] **Step 3: Create the module**

Create `src/alert-blocks.ts` with no import statements:

```ts
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
```

`approvalId` is unused in `buildDecisionBlocks`, exactly as it is unused in the original — keep it, because changing the signature would break the legacy call in `src/slack_routes.ts:54`.

- [ ] **Step 4: Delete the moved functions from `src/slack.ts` and re-export**

In `src/slack.ts`, delete the `buildApprovalBlocks` function (lines 27-72, from the `export function buildApprovalBlocks` line through its closing brace) and the `buildDecisionBlocks` function (lines 167-182). Leave their header comments in place if you like; do not leave a dangling doc comment that describes nothing.

Then add, at the end of the file:

```ts
import { buildApprovalBlocks, buildDecisionBlocks } from './alert-blocks';
export { buildApprovalBlocks, buildDecisionBlocks };
```

**Both lines are required.** `export { ... } from './alert-blocks'` on its own would not compile: `src/slack.ts:95` calls `buildApprovalBlocks(...)` from inside `postApprovalToSlack`, and a re-export creates no local binding. The `import` gives the local name, the `export` keeps `src/slack_routes.ts:2` working.

Leave `postApprovalToSlack` and `handleSlackAction` exactly as they are.

- [ ] **Step 5: Verify it typechecks and the legacy call sites still resolve**

Run: `npm run typecheck`
Expected: no output, exit 0. If it reports `Cannot find name 'buildApprovalBlocks'` inside `src/slack.ts`, Step 4's `import` line was not added.

- [ ] **Step 6: Run the tests**

Run: `npm run build && node --test tests/alerts.mjs`
Expected: all blocks PASS — the Task 1 schema test and both new block-builder tests.

- [ ] **Step 7: Commit**

```bash
git add src/alert-blocks.ts src/slack.ts tests/alerts.mjs
git commit -m "Move Slack block builders into a side-effect-free module"
```

---

### Task 3: URL validation and address blocking in `src/alert-url.ts`

**Files:**
- Create: `src/alert-url.ts`
- Test: `tests/alerts.mjs`

**Interfaces:**
- Consumes: nothing but Node built-ins (`node:net`, `node:dns`).
- Produces:
  - `validChannelUrl(value: unknown): { url: string; host: string }` — throws an error with `status: 400` on any invalid input; returns the normalized `href` to store.
  - `isBlockedAddress(address: string): boolean`
  - `assertDeliverableAddress(host: string): Promise<void>` — throws when a literal address is blocked, or when any resolved address is blocked.

  Task 4 calls `validChannelUrl` from `saveChannel` and `assertDeliverableAddress` from `deliver`.

- [ ] **Step 1: Write the failing tests**

Add inside the `try` in `tests/alerts.mjs`:

```js
  await t.test('alert URLs are validated and internal addresses are refused',async()=>{
   const {validChannelUrl,isBlockedAddress,assertDeliverableAddress}=require('../dist/alert-url.js');
   const ok=validChannelUrl('https://hooks.slack.com/services/T000/B000/XXXX');
   assert.equal(ok.url,'https://hooks.slack.com/services/T000/B000/XXXX');
   assert.equal(ok.host,'hooks.slack.com');
   const bad=(value,label)=>{assert.throws(()=>validChannelUrl(value),error=>error.status===400,label);};
   bad('http://hooks.slack.com/services/x','http must be refused');
   bad('not a url','garbage must be refused');
   bad('https://user:pass@hooks.slack.com/x','embedded credentials must be refused');
   bad('https://localhost/hook','localhost must be refused');
   bad('https://127.0.0.1/hook','loopback must be refused');
   bad('https://169.254.169.254/latest/meta-data','link-local metadata must be refused');
   bad('https://10.0.0.5/hook','private range must be refused');
   bad('https://192.168.1.10/hook','private range must be refused');
   bad('https://172.16.4.4/hook','private range must be refused');
   bad('https://[::1]/hook','IPv6 loopback must be refused');
   bad('https://x.test/'+'a'.repeat(1200),'over-long URL must be refused');
   for(const address of ['127.0.0.1','10.1.2.3','169.254.169.254','172.20.0.1','192.168.0.1','100.64.0.1','0.0.0.0','224.0.0.1','::1','::','fd00::1','fe80::1','::ffff:127.0.0.1'])assert.equal(isBlockedAddress(address),true,address);
   for(const address of ['93.184.216.34','8.8.8.8','2606:4700::1111','::ffff:8.8.8.8'])assert.equal(isBlockedAddress(address),false,address);
   await assert.rejects(assertDeliverableAddress('169.254.169.254'));
   await assert.rejects(assertDeliverableAddress('localhost'));
   await assert.doesNotReject(assertDeliverableAddress('93.184.216.34'));
  });
```

The `localhost` case exercises the DNS branch, which resolves from the host file and needs no network. Nothing else here performs a lookup.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test tests/alerts.mjs`
Expected: FAIL — `Cannot find module '../dist/alert-url.js'`.

- [ ] **Step 3: Write the module**

Create `src/alert-url.ts`:

```ts
import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';

/** Loopback, private, link-local, carrier-grade NAT, multicast and unspecified ranges. */
function blockedV4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19));
}

export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return blockedV4(address);
  if (version !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blockedV4(mapped[1]);
  const normalised = address.toLowerCase();
  return normalised === '::' || normalised === '::1'
    || /^f[cd]/.test(normalised)
    || /^fe[89ab]/.test(normalised)
    || /^ff/.test(normalised);
}

const fail = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }); };

/** Validates a channel URL and returns the normalized href to store. */
export function validChannelUrl(value: unknown): { url: string; host: string } {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) fail('An alert URL is required.');
  if (raw.length > 1000) fail('Alert URLs must be 1000 characters or fewer.');
  const parsed = ((): URL => { try { return new URL(raw); } catch { return fail('Enter a valid alert URL.'); } })();
  if (parsed.protocol !== 'https:') fail('Alert URLs must use https.');
  if (parsed.username || parsed.password) fail('Remove the credentials from the alert URL.');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host) fail('Enter a valid alert URL.');
  if (host === 'localhost' || host.endsWith('.localhost')) fail('Alert URLs cannot point at localhost.');
  if (isBlockedAddress(host)) fail('Alert URLs cannot point at a private or internal address.');
  return { url: parsed.href, host };
}

/**
 * Refuses delivery to a host that resolves anywhere internal. The hostname is resolved
 * at send time because DNS can change after the URL was saved.
 *
 * Known limit: fetch resolves the host again when it connects, so an authoritative server
 * that answers differently between this check and the connection can still win the race.
 * Redirects are refused and only an authenticated operator can supply the URL at all.
 */
export async function assertDeliverableAddress(host: string): Promise<void> {
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('Address is not publicly routable.');
    return;
  }
  const addresses = await dns.lookup(host, { all: true });
  if (!addresses.length) throw new Error('Host did not resolve.');
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) throw new Error('Host resolves to a private address.');
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && node --test tests/alerts.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/alert-url.ts tests/alerts.mjs
git commit -m "Add alert URL validation and internal-address blocking"
```

---

### Task 4: `src/alerts.ts` — channels, payloads, signing, delivery

**Files:**
- Create: `src/alerts.ts`
- Test: `tests/alerts.mjs`

**Interfaces:**
- Consumes: `buildApprovalBlocks`, `buildIncidentBlocks`, `buildHaltedBlocks`, `buildTestBlocks` from `./alert-blocks`; `validChannelUrl`, `assertDeliverableAddress` from `./alert-url`; `query` from `./db`.
- Produces:
  - `type AlertEvent` — the discriminated union below
  - `interface DeliveryResult { kind: string; ok: boolean; status?: number; error?: string }`
  - `type AlertTransport`
  - `setAlertTransport(next: AlertTransport | null): void`
  - `flushAlerts(): Promise<void>`
  - `signBody(secret: string, body: string): string`
  - `listChannels(orgId: string): Promise<any[]>` — **no `secret` column is selected**
  - `readDeliveryChannels(orgId: string): Promise<any[]>` — includes `secret`
  - `saveChannel(orgId: string, body: any): Promise<any>`
  - `removeChannel(orgId: string, kind: unknown): Promise<void>`
  - `notify(orgId: string, event: AlertEvent): Promise<DeliveryResult[]>` — resolves, never rejects
  - `sendTest(orgId: string): Promise<{ ok: boolean; delivered: DeliveryResult[] }>`

  Task 5 calls the channel functions and `sendTest`; Tasks 6 and 7 call `notify`.

- [ ] **Step 1: Write the failing tests**

First extend the harness. Add `createHmac` to the `node:crypto` import at the top of `tests/alerts.mjs`:

```js
import { randomUUID, createHmac } from 'node:crypto';
```

and add these beside the other helpers, above `try{`:

```js
const {setAlertTransport,flushAlerts}=require('../dist/alerts.js');
const sent=[];
setAlertTransport(async(url,init)=>{sent.push({url,headers:init.headers,body:init.body});return {status:200};});
async function drain(){await flushAlerts();const copy=sent.slice();sent.length=0;return copy;}
```

The recorder is installed at module load, before any test runs, so no test in this file can reach the network. `drain()` waits for in-flight notifications and returns what the recorder captured — that is why the tests never poll or sleep.

Then add this inside the `try`:

```js
  await t.test('channels are stored per workspace and never return their secret',async()=>{
   const a=await signup('Alert Alice'), b=await signup('Alert Bob');
   const {saveChannel,listChannels,removeChannel}=require('../dist/alerts.js');
   const saved=await saveChannel(a.profile.org_id,{kind:'webhook',url:'https://example.test/hook',secret:'a-signing-secret-value'});
   assert.equal(saved.url,'https://example.test/hook');
   assert.equal(saved.secret,undefined);
   const listed=await listChannels(a.profile.org_id);
   assert.equal(listed.length,1);
   assert.equal(listed[0].secret,undefined);
   assert.equal(listed[0].kind,'webhook');
   assert.deepEqual(await listChannels(b.profile.org_id),[]);
   await assert.rejects(saveChannel(a.profile.org_id,{kind:'sms',url:'https://example.test/hook'}),error=>error.status===400);
   await assert.rejects(saveChannel(a.profile.org_id,{kind:'webhook',url:'http://example.test/hook'}),error=>error.status===400);
   await assert.rejects(saveChannel(a.profile.org_id,{kind:'webhook',url:'https://example.test/hook',secret:'short'}),error=>error.status===400);
   await assert.rejects(saveChannel(b.profile.org_id,{kind:'webhook',url:'https://example.test/hook'}),error=>error.status===400);
   await assert.rejects(saveChannel(a.profile.org_id,{kind:'slack',url:'https://example.test/hook',secret:'a-signing-secret-value'}),error=>error.status===400);
   await assert.rejects(removeChannel(a.profile.org_id,'sms'),error=>error.status===400);
   await assert.rejects(removeChannel(b.profile.org_id,'webhook'),error=>error.status===404);
   await removeChannel(a.profile.org_id,'webhook');
   assert.deepEqual(await listChannels(a.profile.org_id),[]);
  });
  await t.test('a blank secret on update keeps the stored signing key',async()=>{
   const a=await signup('Alert Carol');
   const {saveChannel,readDeliveryChannels,sendTest}=require('../dist/alerts.js');
   await saveChannel(a.profile.org_id,{kind:'webhook',url:'https://example.test/one',secret:'first-signing-secret'});
   await saveChannel(a.profile.org_id,{kind:'webhook',url:'https://example.test/two'});
   const channels=await readDeliveryChannels(a.profile.org_id);
   assert.equal(channels.length,1);
   assert.equal(channels[0].url,'https://example.test/two');
   assert.equal(channels[0].secret,'first-signing-secret');
   const tested=await sendTest(a.profile.org_id);
   assert.equal(tested.ok,true);
   const delivery=(await drain())[0];
   assert.equal(delivery.url,'https://example.test/two');
   assert.equal(delivery.headers['X-AgentOnCall-Event'],'test');
   assert.equal(delivery.headers['X-AgentOnCall-Signature'],`sha256=${createHmac('sha256','first-signing-secret').update(delivery.body).digest('hex')}`);
   const slack=await saveChannel(a.profile.org_id,{kind:'slack',url:'https://example.test/slack'});
   assert.equal(slack.kind,'slack');
   assert.equal((await readDeliveryChannels(a.profile.org_id)).find(c=>c.kind==='slack').secret,'');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && node --test tests/alerts.mjs`
Expected: FAIL — `Cannot find module '../dist/alerts.js'`.

- [ ] **Step 3: Write the channel half of the module**

Create `src/alerts.ts`:

```ts
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
```

- [ ] **Step 4: Run the channel tests**

Run: `npm run build && node --test tests/alerts.mjs`
Expected: both PASS.

- [ ] **Step 5: Write the failing delivery tests**

Add inside the `try` in `tests/alerts.mjs`:

```js
  await t.test('deliveries are signed and contain only the triggering workspace data',async()=>{
   const a=await signup('Alert Dave');
   const {saveChannel,notify,signBody,setAlertTransport}=require('../dist/alerts.js');
   const {createHmac}=await import('node:crypto');
   await saveChannel(a.profile.org_id,{kind:'webhook',url:'https://example.test/hook',secret:'a-signing-secret-value'});
   const agent=(await pool.query("INSERT INTO agents(org_id,name,type,owner_email,status,last_seen_at) VALUES($1,'Signed worker','test','dave@example.test','in_progress',now()) RETURNING id",[a.profile.org_id])).rows[0];
   const task=(await pool.query("INSERT INTO tasks(org_id,agent_id,title,source,status) VALUES($1,$2,'Sign this delivery','test','paused') RETURNING id",[a.profile.org_id,agent.id])).rows[0];
   const approval=(await pool.query("INSERT INTO approval_requests(task_id,agent_id,type,context,status) VALUES($1,$2,'review',$3,'pending') RETURNING id",[task.id,agent.id,JSON.stringify({action:'Check result'})])).rows[0];
   await notify(a.profile.org_id,{type:'approval_requested',approvalId:approval.id});
   const batches=await drain();
   assert.equal(batches.length,1);
   const delivery=batches[0];
   assert.equal(delivery.url,'https://example.test/hook');
   assert.equal(delivery.headers['X-AgentOnCall-Event'],'approval_requested');
   const expected=createHmac('sha256','a-signing-secret-value').update(delivery.body).digest('hex');
   assert.equal(delivery.headers['X-AgentOnCall-Signature'],`sha256=${expected}`);
   assert.equal(delivery.headers['X-AgentOnCall-Signature'],`sha256=${signBody('a-signing-secret-value',delivery.body)}`);
   const payload=JSON.parse(delivery.body);
   assert.equal(payload.event,'approval_requested');
   assert.equal(payload.workspace.id,a.profile.org_id);
   assert.equal(payload.data.approval_id,approval.id);
   assert.equal(payload.data.task_title,'Sign this delivery');
   assert.equal(payload.data.agent.name,'Signed worker');
   assert.ok(payload.occurred_at);
  });
  await t.test('slack deliveries carry blocks, no signature, and no decide buttons',async()=>{
   const a=await signup('Alert Erin');
   const {saveChannel,notify}=require('../dist/alerts.js');
   await saveChannel(a.profile.org_id,{kind:'slack',url:'https://example.test/slack'});
   const agent=(await pool.query("INSERT INTO agents(org_id,name,type,owner_email,status,last_seen_at) VALUES($1,'Slack worker','test','erin@example.test','in_progress',now()) RETURNING id",[a.profile.org_id])).rows[0];
   const task=(await pool.query("INSERT INTO tasks(org_id,agent_id,title,source,status) VALUES($1,$2,'Slack blocks','test','paused') RETURNING id",[a.profile.org_id,agent.id])).rows[0];
   const approval=(await pool.query("INSERT INTO approval_requests(task_id,agent_id,type,context,status) VALUES($1,$2,'review',$3,'pending') RETURNING id",[task.id,agent.id,JSON.stringify({action:'Check result'})])).rows[0];
   await notify(a.profile.org_id,{type:'approval_requested',approvalId:approval.id});
   const delivery=(await drain())[0];
   assert.equal(delivery.headers['X-AgentOnCall-Signature'],undefined);
   const payload=JSON.parse(delivery.body);
   assert.match(payload.text,/Approval needed: review/);
   assert.equal(payload.blocks.some(b=>b.type==='actions'),false);
   assert.match(JSON.stringify(payload.blocks),/Slack blocks/);
   assert.match(JSON.stringify(payload.blocks),approval.id);
   assert.match(JSON.stringify(payload.blocks),/in your AgentOnCall dashboard/);
  });
  await t.test('a workspace with no channel sends nothing and a broken destination cannot break the caller',async()=>{
   const a=await signup('Alert Frank');
   const {notify,setAlertTransport}=require('../dist/alerts.js');
   assert.deepEqual(await notify(a.profile.org_id,{type:'workspace_halted',stoppedBy:'Frank'}),[]);
   assert.deepEqual(await drain(),[]);
   const b=await signup('Alert Grace');
   const {saveChannel,flushAlerts}=require('../dist/alerts.js');
   await saveChannel(b.profile.org_id,{kind:'webhook',url:'https://example.test/broken',secret:'another-signing-secret'});
   setAlertTransport(async()=>{throw new Error('socket hang up');});
   assert.doesNotReject(notify(b.profile.org_id,{type:'workspace_halted',stoppedBy:'Grace'}));
   const failed=await notify(b.profile.org_id,{type:'workspace_halted',stoppedBy:'Grace'});
   assert.equal(failed.length,1);
   assert.equal(failed[0].ok,false);
   assert.match(failed[0].error,/socket hang up/);
   setAlertTransport(async()=>({status:500}));
   const rejected=await notify(b.profile.org_id,{type:'workspace_halted',stoppedBy:'Grace'});
   assert.equal(rejected[0].ok,false);
   assert.equal(rejected[0].status,500);
   await flushAlerts();
   assert.deepEqual(await drain(),[]);
  });
```

The last two lines of the second-to-last block matter: `setAlertTransport` is restored to a recorder at the end of the block so the following tests still capture deliveries. The recorder used there throws and returns 500 deliberately, then `drain()` clears `sent` — which stays empty because those deliveries never reach the recorder successful path. Reinstall the normal recorder at the end of that block:

```js
   setAlertTransport(async(url,init)=>{sent.push({url,headers:init.headers,body:init.body});return {status:200};});
```

- [ ] **Step 6: Run the delivery tests to verify they fail**

Run: `npm run build && node --test tests/alerts.mjs`
Expected: FAIL — `notify is not a function`.

- [ ] **Step 7: Write the delivery half of the module**

Append to `src/alerts.ts`:

```ts
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
            (SELECT count(*)::int FROM agents WHERE org_id=$1 AND status='halted') AS halted_agents`,
    [orgId]
  ))[0];
  const summary = { stopped_by: event.stoppedBy, halted_tasks: counts.halted_tasks, halted_agents: counts.halted_agents };
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
```

- [ ] **Step 8: Run the delivery tests**

Run: `npm run build && node --test tests/alerts.mjs`
Expected: every test in the file PASSes, including the Task 1 schema test, which can now load the module.

- [ ] **Step 9: Commit**

```bash
git add src/alerts.ts tests/alerts.mjs
git commit -m "Add per-workspace alert delivery with HMAC signing"
```

---

### Task 5: The `/api/v1/alerts` endpoints

**Files:**
- Modify: `src/workspace-api.ts` (imports, plus four routes before the 404 fallback at line 173)
- Test: `tests/alerts.mjs`

**Interfaces:**
- Consumes: `listChannels`, `saveChannel`, `removeChannel`, `sendTest` from `./alerts`; the existing `identity`, `requireSession` helpers and the post-commit `notify` convention.
- Produces: `GET`, `PUT`, `DELETE`, `POST /api/v1/alerts`. Task 8's dashboard panel calls all four.

**Note on error statuses:** thrown errors carrying `status` are converted to HTTP responses by the handler at `src/index.ts:36-40`, so the routes need no try/catch. `PUT` returns 200 rather than 201, because it is an upsert and the caller cannot tell which happened.

- [ ] **Step 1: Write the failing tests**

Add inside the `try` in `tests/alerts.mjs`:

```js
  await t.test('the alerts API is operator-only, scoped, and reports delivery results',async()=>{
   const a=await signup('Alert Heidi'), b=await signup('Alert Ivan');
   const call=(path,method='GET',body)=>request('/api/v1'+path,{method,body,cookie:a.cookie});
   const other=(path,method='GET',body)=>request('/api/v1'+path,{method,body,cookie:b.cookie});
   assert.equal((await request('/api/v1/alerts',{method:'POST'})).status,401);
   assert.equal((await request('/api/v1/alerts',{method:'POST',cookie:a.cookie,body:{},origin:null})).status,403);
   const saved=await call('/alerts','PUT',{kind:'slack',url:'https://example.test/slack'});
   assert.equal(saved.status,200);
   assert.equal(saved.data.kind,'slack');
   assert.equal(saved.data.secret,undefined);
   const listed=await call('/alerts');
   assert.equal(listed.status,200);
   assert.equal(listed.data.channels.length,1);
   assert.equal(listed.data.channels[0].secret,undefined);
   assert.equal(listed.data.channels[0].url,'https://example.test/slack');
   assert.deepEqual((await other('/alerts')).data.channels,[]);
   assert.equal((await other('/alerts?kind=slack','DELETE')).status,404);
   assert.equal((await call('/alerts','PUT',{kind:'sms',url:'https://example.test/x'})).status,400);
   assert.equal((await call('/alerts','PUT',{kind:'webhook',url:'http://example.test/x'})).status,400);
   assert.equal((await call('/alerts','PUT',{kind:'webhook',url:'https://169.254.169.254/latest'})).status,400);
   assert.equal((await call('/alerts?kind=sms','DELETE')).status,400);
   const key=await call('/keys','POST',{name:'Alert agent'});
   assert.equal(key.status,201);
   const machine=(path,method='GET',body)=>request('/api/v1'+path,{key:key.data.token,origin:null,method,body});
   for(const [path,method,body] of [['/alerts','GET'],['/alerts','PUT',{kind:'slack',url:'https://example.test/x'}],['/alerts?kind=slack','DELETE'],['/alerts','POST']]){
    const denied=await machine(path,method,body);
    assert.equal(denied.status,403,`${method} ${path} must refuse an agent key`);
   }
   const tested=await call('/alerts','POST',{});
   assert.equal(tested.status,200);
   assert.equal(tested.data.ok,true);
   assert.deepEqual(tested.data.delivered.map(d=>d.kind),['slack']);
   assert.equal((await drain()).length,1);
   const empty=await other('/alerts','POST',{});
   assert.equal(empty.status,409);
   assert.match(empty.data.error,/Configure an alert channel first/);
   assert.equal((await other('/alerts','PUT',{kind:'webhook',url:'https://example.test/hook',secret:'a-signing-secret-value'})).status,200);
   const signed=await other('/alerts','POST',{});
   assert.equal(signed.status,200);
   assert.equal(signed.data.ok,true);
   assert.deepEqual(signed.data.delivered.map(d=>d.kind),['webhook']);
   const webhook=(await drain())[0];
   assert.equal(webhook.url,'https://example.test/hook');
   assert.equal(webhook.headers['X-AgentOnCall-Event'],'test');
   assert.equal(webhook.headers['X-AgentOnCall-Signature'],`sha256=${createHmac('sha256','a-signing-secret-value').update(webhook.body).digest('hex')}`);
   assert.match(webhook.body,/"message":"Test alert from AgentOnCall\."/);
   const {setAlertTransport}=require('../dist/alerts.js');
   setAlertTransport(async()=>({status:404}));
   const failed=await other('/alerts','POST',{});
   assert.equal(failed.status,200);
   assert.equal(failed.data.ok,false);
   assert.equal(failed.data.delivered[0].status,404);
   setAlertTransport(async(url,init)=>{sent.push({url,headers:init.headers,body:init.body});return {status:200};});
   await drain();
   assert.equal((await call('/alerts?kind=slack','DELETE')).status,200);
   assert.deepEqual((await call('/alerts')).data.channels,[]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test tests/alerts.mjs`
Expected: FAIL — the first `GET /api/v1/alerts` returns 404 from the workspace API's fallback handler.

- [ ] **Step 3: Add the routes**

In `src/workspace-api.ts`, extend the existing import on line 4:

```ts
import { identity, requireSession, digest, textField } from './auth';
import { listChannels, saveChannel, removeChannel, sendTest } from './alerts';
```

Then insert these four routes immediately **before** the 404 fallback at line 173 (`// Legacy demos execute host commands or notify a shared Slack channel.`):

```ts
workspaceApi.get('/alerts',requireSession,async(req,res)=>res.json({channels:await listChannels(identity(res).org_id)}));
workspaceApi.put('/alerts',requireSession,async(req,res)=>res.json({ok:true,...await saveChannel(identity(res).org_id,req.body)}));
workspaceApi.delete('/alerts',requireSession,async(req,res)=>{await removeChannel(identity(res).org_id,req.query.kind);res.json({ok:true});});
workspaceApi.post('/alerts',requireSession,async(req,res)=>res.json(await sendTest(identity(res).org_id)));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && node --test tests/alerts.mjs`
Expected: PASS.

- [ ] **Step 5: Confirm the whole suite is still green**

Run: `npm test`
Expected: every test in `tests/onboarding.mjs` and `tests/alerts.mjs` PASSes.

- [ ] **Step 6: Commit**

```bash
git add src/workspace-api.ts tests/alerts.mjs
git commit -m "Add the operator-only alerts API"
```

---

### Task 6: Fire on approval request, incident and workspace stop

**Files:**
- Modify: `src/workspace-api.ts:110-120` (`POST /approvals`), `:136-141` (`POST /incidents`), `:145-154` (`POST /emergency/stop`)
- Test: `tests/alerts.mjs`

**Interfaces:**
- Consumes: `notify` from `./alerts`.
- Produces: nothing new. `POST /approvals` must keep returning the raw `approval_requests` row as its 201 body, and `POST /incidents` must keep returning the raw incident row as its 201 body.

- [ ] **Step 1: Write the failing tests**

Add inside the `try` in `tests/alerts.mjs`:

```js
  await t.test('approval requests, incidents and workspace stops notify their own workspace only',async()=>{
   const a=await signup('Alert Judy'), b=await signup('Alert Karl');
   const call=(path,method='GET',body)=>request('/api/v1'+path,{method,body,cookie:a.cookie});
   const other=(path,method='GET',body)=>request('/api/v1'+path,{method,body,cookie:b.cookie});
   await call('/alerts','PUT',{kind:'webhook',url:'https://example.test/only-a',secret:'a-signing-secret-value'});
   const key=(await call('/keys','POST',{name:'Notify agent'})).data;
   const machine=(path,method='GET',body)=>request('/api/v1'+path,{key:key.token,origin:null,method,body});
   const agent=(await machine('/agents','POST',{name:'Notify worker',type:'test'})).data;
   const task=(await call('/tasks','POST',{title:'Approve the deploy'})).data;
   await machine(`/tasks/${task.id}/claim`,'POST',{agentId:agent.id});
   await machine(`/tasks/${task.id}/status`,'PATCH',{status:'in_progress'});
   await drain();
   const approval=(await machine('/approvals','POST',{taskId:task.id,agentId:agent.id,type:'review',context:{action:'Deploy'}})).data;
   let batches=await drain();
   assert.equal(batches.length,1);
   assert.equal(batches[0].headers['X-AgentOnCall-Event'],'approval_requested');
   assert.equal(JSON.parse(batches[0].body).data.approval_id,approval.id);
   assert.equal(JSON.parse(batches[0].body).workspace.name,'Alert Judy workspace');
   const bKey=(await other('/keys','POST',{name:'Bob agent'})).data;
   const bMachine=(path,method='GET',body)=>request('/api/v1'+path,{key:bKey.token,origin:null,method,body});
   const bAgent=(await bMachine('/agents','POST',{name:'Bob worker',type:'test'})).data;
   const bTask=(await other('/tasks','POST',{title:'Bob approval'})).data;
   await bMachine(`/tasks/${bTask.id}/claim`,'POST',{agentId:bAgent.id});
   await bMachine(`/tasks/${bTask.id}/status`,'PATCH',{status:'in_progress'});
   assert.equal((await bMachine('/approvals','POST',{taskId:bTask.id,agentId:bAgent.id,type:'review',context:{action:'Bob only'}})).status,201);
   assert.deepEqual(await drain(),[]);
   assert.equal((await other('/incidents','POST',{title:'Bob incident only'})).status,201);
   assert.deepEqual(await drain(),[]);
   assert.equal((await call('/incidents','POST',{title:'Alice incident'})).status,201);
   batches=await drain();
   assert.equal(batches.length,1);
   assert.equal(batches[0].headers['X-AgentOnCall-Event'],'incident_created');
   assert.equal(JSON.parse(batches[0].body).data.title,'Alice incident');
   assert.equal((await other('/emergency/stop','POST',{})).status,200);
   assert.deepEqual(await drain(),[]);
   assert.equal((await call('/emergency/stop','POST',{})).status,200);
   batches=await drain();
   assert.deepEqual(batches.map(b=>b.headers['X-AgentOnCall-Event']).sort(),['incident_created','workspace_halted']);
   const halted=JSON.parse(batches.find(b=>b.headers['X-AgentOnCall-Event']==='workspace_halted').body);
   assert.equal(halted.data.stopped_by,'Alert Judy');
   assert.equal(halted.data.halted_tasks,1);
   assert.match(JSON.stringify(JSON.parse(batches.find(b=>b.headers['X-AgentOnCall-Event']==='incident_created').body).data.title),/EMERGENCY STOP/);
  });
  await t.test('a failing destination never changes the response of the request that triggered it',async()=>{
   const a=await signup('Alert Leo');
   const call=(path,method='GET',body)=>request('/api/v1'+path,{method,body,cookie:a.cookie});
   const {setAlertTransport}=require('../dist/alerts.js');
   await call('/alerts','PUT',{kind:'webhook',url:'https://example.test/flaky',secret:'a-signing-secret-value'});
   setAlertTransport(async()=>{throw new Error('connection refused');});
   assert.equal((await call('/incidents','POST',{title:'Still created'})).status,201);
   setAlertTransport(async()=>{throw new Error('connection refused');});
   assert.equal((await call('/emergency/stop','POST',{})).status,200);
   assert.equal((await call('/emergency/status')).data.isHalted,true);
   await flushAlerts();
   setAlertTransport(async(url,init)=>{sent.push({url,headers:init.headers,body:init.body});return {status:200};});
   sent.length=0;
  });
```

Note the ordering claim: the two alerts from `emergency/stop` are started concurrently, so this asserts on the **set** of events, never on their order.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && node --test tests/alerts.mjs`
Expected: FAIL — the first assertion `assert.equal(batches.length,1)` receives `0`, because nothing fires yet.

- [ ] **Step 3: Import `notify`**

In `src/workspace-api.ts`, extend the import added in Task 5:

```ts
import { listChannels, saveChannel, removeChannel, sendTest, notify } from './alerts';
```

- [ ] **Step 4: Fire on approval request**

In `src/workspace-api.ts`, `POST /approvals` ends at line 119 with:

```ts
  });res.status(201).json(result);
```

Replace it with:

```ts
  });void notify(org,{type:'approval_requested',approvalId:result.id});res.status(201).json(result);
```

`org` is already in scope from line 111. `result` is the inserted `approval_requests` row, so `result.id` is the approval ID.

- [ ] **Step 5: Fire on incident**

Replace the whole `POST /incidents` handler (lines 136-141) with:

```ts
workspaceApi.post('/incidents',async(req,res)=>{
  const org=identity(res).org_id;
  for(const [field,table] of [['agentId','agents'],['taskId','tasks']])if(req.body[field])found(await query(`SELECT id FROM ${table} WHERE id=$1 AND org_id=$2`,[uuid(req.body[field]),org]));
  const severity=req.body.severity||'warning';if(!['info','warning','high','critical'].includes(severity))fail('Invalid severity.');
  const incident=found(await query('INSERT INTO incidents(org_id,agent_id,task_id,title,description,severity,evidence) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[org,req.body.agentId||null,req.body.taskId||null,textField(req.body.title,'Title',200),String(req.body.description||'').slice(0,5000),severity,JSON.stringify(object(req.body.evidence))]));
  void notify(org,{type:'incident_created',incidentId:incident.id});
  res.status(201).json(incident);
});
```

The response body is byte-for-byte what `found(...)` returned before, so `tests/onboarding.mjs` and the dashboard are unaffected.

- [ ] **Step 6: Fire on workspace stop**

`POST /emergency/stop` (lines 145-154) runs a transaction that ends at line 152 with the incident insert, then answers `{ok:true}` at line 153. Change the transaction so it returns the incident it inserted, and fire both alerts only when it actually did something.

Line 146 is:

```ts
  const u=identity(res);await transaction(async c=>{
```

Change it to:

```ts
  const u=identity(res);const stopped=await transaction(async c=>{
```

Line 152, the incident insert, gains `RETURNING id` and is returned:

```ts
    return (await c.query("INSERT INTO incidents(org_id,title,description,severity) VALUES($1,'EMERGENCY STOP: Workspace paused',$2,'critical') RETURNING id",[u.org_id,`Stopped by ${u.name}. Agent integrations must honor the stopped status before their next action.`])).rows[0];
```

Lines 149-151 are unchanged. Line 153 becomes:

```ts
  });if(stopped)void notify(u.org_id,{type:'incident_created',incidentId:stopped.id});if(stopped)void notify(u.org_id,{type:'workspace_halted',stoppedBy:u.name});res.json({ok:true});
```

**Both alerts are guarded on `stopped`, and that is the point.** Line 148 is `if(w.halted)return;` — this handler does not answer 409 for an already-stopped workspace, it answers `{ok:true}` after changing nothing. Firing on both paths would re-alert the workspace about an incident that was never inserted, once per repeat click. Guarded, an alert means "this call stopped the workspace", the only reading an operator can act on.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run build && node --test tests/alerts.mjs`
Expected: both PASS.

- [ ] **Step 8: Confirm the whole suite is still green**

Run: `npm test`
Expected: all tests PASS. If `tests/onboarding.mjs` fails on the stop test, the transaction return in Step 6 broke the 409 path — re-read that handler.

- [ ] **Step 9: Commit**

```bash
git add src/workspace-api.ts tests/alerts.mjs
git commit -m "Notify on approval requests, incidents and workspace stops"
```

---

### Task 7: Fire from the workspace watchdog

**Files:**
- Modify: `src/workspace-watchdog.ts`
- Test: `tests/alerts.mjs`

**Interfaces:**
- Consumes: `notify` from `./alerts`.
- Produces: nothing new. `inspectWorkspace(orgId)` **must keep returning the number of candidates it halted**, because `tests/onboarding.mjs:97-98` asserts `1` and then `0`.

- [ ] **Step 1: Write the failing test**

Add inside the `try` in `tests/alerts.mjs`:

```js
  await t.test('the watchdog notifies the affected workspace and keeps its return value',async()=>{
   const a=await signup('Alert Mona'), b=await signup('Alert Nina');
   const call=(path,method='GET',body)=>request('/api/v1'+path,{method,body,cookie:a.cookie});
   const other=(path,method='GET',body)=>request('/api/v1'+path,{method,body:cookie:b.cookie});
   await call('/alerts','PUT',{kind:'webhook',url:'https://example.test/mona',secret:'a-signing-secret-value'});
   await other('/alerts','PUT',{kind:'webhook',url:'https://example.test/nina',secret:'another-signing-secret'});
   const key=(await call('/keys','POST',{name:'Watchdog agent'})).data;
   const machine=(path,method='GET',body)=>request('/api/v1'+path,{key:key.token,origin:null,method,body});
   const agent=(await machine('/agents','POST',{name:'Watchdog worker',type:'test'})).data;
   const task=(await call('/tasks','POST',{title:'Budget watch',budgetUsd:1})).data;
   await machine(`/tasks/${task.id}/claim`,'POST',{agentId:agent.id});
   await machine(`/tasks/${task.id}/status`,'PATCH',{status:'in_progress'});
   await machine(`/tasks/${task.id}/spend`,'POST',{amountUsd:1});
   await drain();
   const {inspectWorkspace}=require('../dist/workspace-watchdog.js');
   assert.equal(await inspectWorkspace(a.profile.org_id),1);
   const batches=await drain();
   assert.equal(batches.length,1);
   assert.equal(batches[0].url,'https://example.test/mona');
   const payload=JSON.parse(batches[0].body);
   assert.equal(payload.event,'incident_created');
   assert.equal(payload.data.title,'Reported budget limit reached');
   assert.equal(payload.workspace.id,a.profile.org_id);
   assert.equal(await inspectWorkspace(a.profile.org_id),0);
   assert.deepEqual(await drain(),[]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test tests/alerts.mjs`
Expected: FAIL — `batches.length` is `0`.

- [ ] **Step 3: Return the incident IDs from the transaction and notify after it commits**

In `src/workspace-watchdog.ts`, add the import:

```ts
import { query, transaction } from './db';
import { notify } from './alerts';
```

Then replace the body of `inspectWorkspace` (lines 4-21) with:

```ts
/** Marks unresponsive or over-budget tasks halted; adapters must enforce the stop. */
export async function inspectWorkspace(orgId: string) {
  const result = await transaction(async client => {
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[orgId]);
    const candidates=await client.query(`SELECT t.*, a.last_seen_at FROM tasks t JOIN agents a ON a.id=t.agent_id
      WHERE t.org_id=$1 AND t.status IN ('claimed','in_progress')
      AND ((t.budget_usd IS NOT NULL AND t.spent_usd>=t.budget_usd)
        OR a.last_seen_at<now()-interval '3 minutes') FOR UPDATE OF t`,[orgId]);
    const incidents: string[] = [];
    for(const task of candidates.rows){
      const budget=task.budget_usd!==null && Number(task.spent_usd)>=Number(task.budget_usd);
      const reason=budget?'Reported budget limit reached':'Agent missed its heartbeat';
      await client.query("UPDATE tasks SET status='halted' WHERE id=$1",[task.id]);
      await client.query("UPDATE agents SET status='halted' WHERE id=$1",[task.agent_id]);
      const incident=await client.query("INSERT INTO incidents(org_id,agent_id,task_id,title,description,severity) VALUES($1,$2,$3,$4,$5,'high') RETURNING id",[orgId,task.agent_id,task.id,reason,'Task marked halted. The connected worker must stop before its next external action.']);
      await client.query("INSERT INTO task_logs(task_id,message,level) VALUES($1,$2,'warn')",[task.id,reason]);
      incidents.push(incident.rows[0].id);
    }
    return {count:candidates.rowCount,incidents};
  });
  for(const incidentId of result.incidents)void notify(orgId,{type:'incident_created',incidentId});
  return result.count;
}
```

Notifications happen strictly after the transaction commits, so a rolling-back transaction never alerts.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && node --test tests/alerts.mjs`
Expected: PASS.

- [ ] **Step 5: Confirm the pre-existing watchdog assertions still hold**

Run: `npm test`
Expected: all tests PASS, including `tests/onboarding.mjs`'s `inspectWorkspace` assertions of `1` then `0`.

- [ ] **Step 6: Commit**

```bash
git add src/workspace-watchdog.ts tests/alerts.mjs
git commit -m "Notify the affected workspace when the watchdog halts a task"
```

---

### Task 8: Settings panel in the dashboard

**Files:**
- Modify: `public/assets/dashboard.js` (lines 51, 55, 58, 59, 64, and three new listeners)
- Modify: `public/assets/app.css` (four selector edits)
- Test: `tests/alerts.mjs`

**Interfaces:**
- Consumes: `GET`, `PUT`, `DELETE`, `POST /api/v1/alerts` from Task 5.
- Produces: a rendered Alerts card with `#alertForm`, `#alertKind`, `#alertUrl`, `#alertSecret`, `#alertSecretField`, and `data-action` values `test-alert` and `remove-alert`.

**One change to shared code:** the delegated click handler's call becomes `await action(b.dataset.action,b)` and `action` gains a second parameter, so the remove button can carry its `kind` in `data-kind`. There is exactly one call site, at line 59.

`public/dashboard.html` needs no change: the panel renders into `#page` from JavaScript. Handlers must be registered with `addEventListener` — the CSP is `script-src 'self'`, so inline handlers would never run.

- [ ] **Step 1: Write the failing test**

Add inside the `try` in `tests/alerts.mjs`:

```js
  await t.test('the dashboard ships an alert panel that talks to the alerts API',async()=>{
   const asset=await request('/assets/dashboard.js');
   assert.equal(asset.status,200);
   assert.match(asset.data,/'\/v1\/alerts'/);
   assert.match(asset.data,/id="alertForm"/);
   assert.match(asset.data,/id="alertKind"/);
   assert.match(asset.data,/id="alertUrl"/);
   assert.match(asset.data,/id="alertSecret"/);
   assert.match(asset.data,/data-action="test-alert"/);
   assert.match(asset.data,/data-action="remove-alert"/);
   assert.match(asset.data,/data-kind=/);
   assert.match(asset.data,/id="alertSecretField"/);
   assert.match(asset.data,/addEventListener\('change'/);
  });
```

The last three assertions carry information the earlier ones do not: the remove button has to carry its `kind` because the endpoint is `/alerts?kind=`, the secret field has to be an element the change listener can hide, and that listener has to exist as a delegated registration rather than an inline handler — the dashboard's CSP is `script-src 'self'`, so an inline handler would never run.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test tests/alerts.mjs`
Expected: FAIL on `assert.match(asset.data, /'\/v1\/alerts'/)`.

- [ ] **Step 3: Fetch the channel list on every refresh**

In `public/assets/dashboard.js:55`, add `alerts` to the destructuring, the path array, and the state object. The line becomes:

```js
async function refresh(force=false){if(refreshing)return;refreshing=true;try{const[workspace,agents,tasks,approvals,incidents,keys,emergency,alerts]=await Promise.all(['/v1/workspace','/v1/agents','/v1/tasks','/v1/approvals','/v1/incidents','/v1/keys','/v1/emergency/status','/v1/alerts'].map(p=>api(p)));state={workspace,agents,tasks,approvals,incidents,keys,emergency,alerts};$('connectionError').hidden=true;$('connectionState').textContent=`Updated ${new Date().toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}`;if(force||!['settings','connect'].includes(view))render();if(logTask&&$('detailDialog').open)await loadLogs(logTask);}catch(error){$('connectionError').textContent=error.message;$('connectionError').hidden=false;$('connectionState').textContent='Connection interrupted';}finally{refreshing=false;}}
```

- [ ] **Step 4: Render the Alerts card**

In `public/assets/dashboard.js:51`, the settings view ends with:

```js
<section class="card"><div class="card-head"><h2>Workspace controls</h2></div><div class="card-body"><p class="muted">Stop new claims and mark active tasks halted. Reopen the workspace when you are ready, then restart each task individually.</p><div class="actions">${button('Stop workspace','stop')}</div></div></section></div>`
```

Append a new section between that section's `</section>` and the grid's closing `</div>`:

```js
${(()=>{const channels=state.alerts.channels,active=channels[0];return `<section class="card"><div class="card-head"><h2>Alerts</h2></div><div class="card-body">${channels.length?channels.map(c=>`<div class="approval-row"><h3>${escapeHTML(c.kind==='slack'?'Slack':c.kind==='webhook'?'Webhook':'Unknown')}</h3><p class="mono">${escapeHTML(c.url)}</p><div class="actions"><button class="small" data-action="test-alert">Send test alert</button><button class="small danger" data-action="remove-alert" data-kind="${escapeHTML(c.kind)}">Remove channel</button></div></div>`).join(''):'<p class="muted">No alert destination yet. Add one to be notified about approval requests, new incidents, and workspace stops.</p>'}<form id="alertForm"><div class="field"><label for="alertKind">Destination</label><select id="alertKind" name="kind"><option value="slack"${active?.kind==='slack'?' selected':''}>Slack incoming webhook</option><option value="webhook"${active?.kind==='webhook'?' selected':''}>My own webhook (signed)</option></select></div><div class="field"><label for="alertUrl">URL</label><input id="alertUrl" name="url" maxlength="1000" value="${escapeHTML(active?.url||'')}" placeholder="https://hooks.slack.com/services/…" required></div><div class="field" id="alertSecretField"${active?.kind==='webhook'?'':' hidden'}><label for="alertSecret">Signing secret</label><input id="alertSecret" name="secret" type="password" autocomplete="new-password" maxlength="200"><small>At least 16 characters, sent to your receiver as an HMAC-SHA256 signature header. Leave blank to keep the current secret.</small></div><button class="primary" type="submit">Save destination</button></form><div class="notice">Alerts are best effort. They are sent once, never retried, and never block the action that triggered them. Approve and reject in the dashboard — notifications are one-way.</div></div></section>`;})()}`
```

`active` is the first configured channel, and `readDeliveryChannels` orders by kind, so Slack sorts before Webhook. It drives three things in one template pass: which `<option>` is `selected`, what the URL field is prefilled with, and whether the secret field starts hidden. That covers both states the spec asks for — configured (prefilled URL, empty secret) and not configured (hint, no prefill, hidden secret) — with no post-render DOM code, because `render()` rebuilds the whole panel on every refresh and the form is always painted from the current list.

The secret input deliberately has no `required` attribute: it is hidden while Slack is selected, and a hidden required input makes the browser refuse to submit the form with no explanation. The server validates the length and returns a readable message. The field is never prefilled — `GET /api/v1/alerts` does not select `secret`, so the dashboard cannot render it even by accident.

- [ ] **Step 5: Wire the save, test and remove actions**

In `public/assets/dashboard.js:58`, insert two cases before the closing `}}` of the `switch`. The line then ends:

```js
case'test-alert':{const result=await post('/v1/alerts');const failed=result.delivered.filter(d=>!d.ok);if(failed.length)toast(`Test failed: ${failed[0].error||('HTTP '+failed[0].status)}`,true);else toast('Test alert sent.');break;}case'remove-alert':{if(!confirm('Remove this alert destination? You will stop receiving notifications.'))break;await api('/v1/alerts?kind='+encodeURIComponent(el.dataset.kind),{method:'DELETE'});await refresh(true);toast('Alert destination removed.');break;}case'resume':await post('/v1/emergency/resume');await refresh(true);toast('Workspace reopened. Restart halted tasks from Tasks.');break;}}
```

and change the function signature on that same line from `async function action(name)` to `async function action(name,el)`.

- [ ] **Step 6: Pass the clicked element through**

In `public/assets/dashboard.js:59`, change:

```js
if(b.dataset.action)await action(b.dataset.action);
```

to:

```js
if(b.dataset.action)await action(b.dataset.action,b);
```

- [ ] **Step 7: Handle the form submit**

In `public/assets/dashboard.js:64`, add `'alertForm'` to the id list:

```js
if(!['taskForm','keyForm','profileForm','alertForm'].includes(e.target.id))return;
```

and add a branch inside the `try`, after the `profileForm` branch:

```js
if(form.id==='alertForm'){const body={kind:values.kind,url:values.url};if(values.secret)body.secret=values.secret;await api('/v1/alerts',{method:'PUT',body:JSON.stringify(body)});form.reset();await refresh(true);toast('Alert destination saved.');}
```

Leaving `alertForm` out of the `target` lookup in that handler's `catch` is deliberate: it falls through to `toast(error.message,true)`, which is how a 400 from the server reaches the user.

- [ ] **Step 8: Reveal the secret field only for a signed webhook**

Add this listener beside the other `document.addEventListener` registrations after line 64:

```js
document.addEventListener('change',e=>{if(e.target.id!=='alertKind')return;const field=$('alertSecretField');field.hidden=e.target.value!=='webhook';if(field.hidden)$('alertSecret').value='';});
```

- [ ] **Step 9: Style the select**

`select` is currently unstyled in `public/assets/app.css` — the string `select` appears zero times. `app.css` is two lines of minified CSS, so match each full selector rather than a fragment. Make these four replacements:

1. `button,input,textarea{font:inherit}` → `button,input,textarea,select{font:inherit}`
2. `button,a,input,textarea{outline-offset:4px}` → `button,a,input,textarea,select{outline-offset:4px}`
3. `.field input,.field textarea{width:100%;border:1px solid #d8e2dd;border-radius:8px;padding:11px 12px;color:var(--ink);background:white}` → `.field input,.field textarea,.field select{width:100%;border:1px solid #d8e2dd;border-radius:8px;padding:11px 12px;color:var(--ink);background:white}`
4. `.field input:focus,.field textarea:focus{border-color:var(--green);outline:3px solid #12715b15}` → `.field input:focus,.field textarea:focus,.field select:focus{border-color:var(--green);outline:3px solid #12715b15}`

`.field input` is type-agnostic, so the `type="password"` secret field inherits its styling with no further change.

- [ ] **Step 10: Run the test to verify it passes**

Run: `npm run build && node --test tests/alerts.mjs`
Expected: PASS.

- [ ] **Step 11: Verify the panel by hand**

The test runner cannot exercise the DOM, so do this once:

Run: `npm start`
Then, in a browser: sign in, open **Settings**, pick **My own webhook (signed)**, confirm the signing-secret field appears, pick **Slack incoming webhook** and confirm it disappears. Save a destination pointing at a URL you control, confirm it appears in the card with the URL in plain text and no secret, click **Send test alert** and confirm either "Test alert sent." or a failure message naming the HTTP status, then **Remove channel** and confirm the card returns to its empty state.

Expected: no console errors. In particular, no CSP violation for script-src, which would mean an inline handler slipped in.

- [ ] **Step 12: Commit**

```bash
git add public/assets/dashboard.js public/assets/app.css tests/alerts.mjs
git commit -m "Add the alert destination panel to workspace settings"
```

---

### Task 9: Document the feature and verify end to end

**Files:**
- Modify: `README.md` (the agent integration section, the "legacy demos" paragraph in Stop and monitoring semantics, and a new Alerts section, and the Validation section)
- Modify: `docs/AGENT_ONCALL_BUILD_PLAN.md:34`
- Test: full suite

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Write the README Alerts section**

In `README.md`, add this section immediately before `## Stop and monitoring semantics`:

```markdown
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
```

- [ ] **Step 2: Correct the two paragraphs that now say alerting does not exist**

In `README.md`, in `## Stop and monitoring semantics`, replace the final paragraph:

```markdown
Legacy host-command demos and shared Slack callbacks are not mounted on the public account API. Their source remains for reference. Approvals for new workspaces are handled in the dashboard; per-workspace Slack setup is a future integration.
```

with:

```markdown
Legacy host-command demos and shared Slack callbacks are not mounted on the public account API. Their source remains for reference. Approvals are decided in the dashboard, and outbound alerts are per workspace (see **Alerts**); verified interactive Slack callbacks are not implemented, so notifications are one-way.
```

In `README.md`, in `## Validation`, replace `They make no Slack or email calls.` with:

```markdown
They make no Slack, webhook or email calls: alert deliveries are replaced with a recorder in the tests.
```

- [ ] **Step 3: Update the build plan**

In `docs/AGENT_ONCALL_BUILD_PLAN.md:34`, replace the line that reads `- Per-workspace Slack installation and verified interactive callbacks are not enabled yet.` with:

```markdown
- Per-workspace outbound alerts (Slack or a signed webhook) are implemented. Slack OAuth installation and verified interactive callbacks are not: notifications are one-way, and approvals are decided in the dashboard.
```

- [ ] **Step 4: Run the full suite from a clean build**

Run: `npm run migrate && npm run typecheck && npm test`
Expected: `npm run migrate` reports `skip 004_alert_channels.sql (already applied)`. `typecheck` prints nothing. Every test in both files PASSes.

- [ ] **Step 5: Confirm nothing in the alerting path can reach another workspace**

Read `src/alerts.ts` and check every query against this list — this is the property the whole feature exists for:

- `listChannels` and `readDeliveryChannels` filter `WHERE org_id=$1`
- `saveChannel` reads and writes only `(org_id, kind)` rows
- `removeChannel` deletes `WHERE org_id=$1 AND kind=$2`
- `loadEvent` filters approvals by `t.org_id=$2` and incidents by `org_id=$2`
- `dispatch` passes the `orgId` it was given to both the channel read and `loadEvent`

Expected: all five hold. If any lookup is missing an `org_id` filter, fix it before committing.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/AGENT_ONCALL_BUILD_PLAN.md
git commit -m "Document per-workspace alerting"
```

---

## Plan self-review

**Spec coverage.** Every spec section maps to a task: schema and its registration → 1; the module split and the re-export → 2; the event contract, payloads, signing, delivery semantics and the two testing seams → 4; URL validation and the send-time address check → 3; all four endpoints including the 409 and the 200-with-`ok:false` → 5; the four firing sites and the two-alerts-on-stop decision → 6 and 7; the dashboard panel, the three CSS edits and the no-inline-handler constraint → 8; the README section, the "future integration" correction and the build plan line → 9. The spec's "no `approval_decided` event" decision is honored: Task 2 moves `buildDecisionBlocks` with no caller.

**One spec deviation, deliberate and stated:** the spec says the two builders move verbatim. Task 2 adds an optional, defaulted fourth parameter to `buildApprovalBlocks` so alerts do not carry Approve/Reject buttons that cannot work. The default preserves the legacy call site's behavior exactly.

**One spec detail refined by the implementation:** the spec has `deliver()` always run the send-time address check. Task 4 instead skips it when a transport is injected, because the check exists to guard the real network and an injected transport is a test double. The check itself is still covered by direct unit tests in Task 3, including the DNS branch.

**Type consistency.** `notify(orgId, event)` takes the `AlertEvent` union and returns `Promise<DeliveryResult[]>`; Tasks 6 and 7 call it with the three union members and only ever `void` the result. `saveChannel(orgId, body)` returns a row with `kind`, `url` and `updated_at`, which is what Task 5 spreads into the `PUT` response. `listChannels` deliberately does not select `secret`, which is what makes Task 5's `secret === undefined` assertions true by construction rather than by discipline. `setAlertTransport` and `flushAlerts` are used by every test block in `tests/alerts.mjs`.
