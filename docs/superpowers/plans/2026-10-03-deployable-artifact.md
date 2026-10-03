# Make AgentOnCall deployable

**Goal:** produce a container image and a documented deployment topology that a
competent operator could stand up on a server without reading the source.

**Explicit non-goal:** this pass adds **no password reset**. A user who forgets
their password still cannot recover the account. That is the one hard blocker to
handing credentials to anyone outside this laptop, and this plan does not clear
it. Chosen deliberately — deployability first, recovery next.

**Also out of scope:** multi-user roles, email, alert retries, retention policy.

---

## The finding that drives half this work

`checkOrigin` builds the value it compares against the browser's `Origin` header
from `req.protocol`:

```ts
export function checkOrigin(req: Request, res: Response, next: NextFunction) {
  if (['GET','HEAD','OPTIONS'].includes(req.method) || identity(res)?.mode === 'key') { next(); return; }
  const expected = `${req.protocol}://${req.get('host')}`;
  if (req.get('origin') !== expected) { res.status(403).json({ error: 'Request origin is not allowed.' }); return; }
  next();
}
```

`req.protocol` is `https` only when Express trusts the proxy that terminated TLS.
Today that works by accident of the documented topology — `cloudflared` runs on
the same host, so it connects over loopback, and `app.set('trust proxy','loopback')`
(line 11 of `src/index.ts`) accepts its `X-Forwarded-Proto`.

Put the app in a container with the usual companion reverse proxy — nginx or
Caddy as a **separate container** — and that stops holding. The proxy is not on
loopback, so its `X-Forwarded-Proto: https` is ignored, `req.protocol` stays
`http`, `expected` becomes `http://host`, the browser sends `https://host`, and
**every mutating request 403s.** Login, approvals, alerts configuration, all of
it. The failure looks like a CSRF rejection, which is a genuinely confusing thing
to debug at 2am.

So `trust proxy` has to come from configuration, and the topology that each
setting assumes has to be written down. This is the single most important thing
this pass fixes, and it is a two-line change surrounded by an essay.

---

## Deliverables

### 1. Runtime configuration — `src/config.ts` (new)

Read once at import, exported as one object so it is greppable:

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. Default stays loopback — an unconfigured app must not appear on a public interface. |
| `PORT` | `3000` | Unchanged. |
| `TRUST_PROXY` | `loopback` | Passed to `app.set('trust proxy', ...)`. Accepts Express's own vocabulary: `loopback`, `false`, `1`, a CIDR list. |
| `NODE_ENV` | `development` | Standard. |
| `DATABASE_URL` | local default | **In `NODE_ENV=production`, absent `DATABASE_URL` becomes a startup error** instead of silently using the committed local credentials. |

`src/index.ts` imports `host` and `trustProxy` from it; the `app.listen` call
uses `host` instead of the hardcoded `'127.0.0.1'`.

### 2. `Dockerfile` (new)

Multi-stage, and the runtime stage carries only what running needs:

- **Build stage** — full source, `npm ci`, `tsc`.
- **Runtime stage** — `dist/`, `public/`, `migrations/`, `scripts/`, production
  dependencies only (`npm ci --omit=dev`).
- Runs as a **non-root user**.
- `HEALTHCHECK` against the existing `GET /health`, which already returns 503
  when the database is unreachable — so the healthcheck means something.
- Base image pinned to a real, currently-published tag; verified by actually
  building, not assumed. Dependencies require Node >=18 and the build targets
  ES2022, so any current LTS satisfies both.
- `CMD` runs an entrypoint that optionally migrates (see 3) then `exec`s the
  server, so signals reach Node and the existing SIGTERM handler keeps working
  rather than being swallowed by a shell.

### 3. Migrations on boot

`scripts/migrate.mjs` already takes an advisory lock and applies each migration
in its own transaction, so it is safe to run concurrently and safe to re-run.

- `RUN_MIGRATIONS=1` makes the entrypoint run it before starting.
- Default off, because the deploy story for a schema change should be a
  deliberate `docker compose run --rm app node scripts/migrate.mjs`, not
  something that happens implicitly whenever a container restarts.
- The migration list stays explicit and ordered, as it is now. Adding a
  migration means adding the file and its name; that convention is worth keeping
  and is documented rather than changed.

### 4. `docker-compose.yml` (new)

- `db` — Postgres with a **named volume**, a `pg_isready` healthcheck, and **no
  published port**: reachable on the compose network only.
- `app` — built from the Dockerfile, `depends_on: db: condition: service_healthy`,
  environment from `.env`, and published to `127.0.0.1:3000` on the host rather
  than `0.0.0.0:3000`. The reverse proxy is what faces the internet; a bare app
  port has no TLS and no rate limiting in front of it.
- `RUN_MIGRATIONS=1` set here, since compose is the path a new operator takes
  and an empty database with no tables is a bad first experience.

### 5. `.env.example` (new)

Every variable from 1, with the safe default and a comment saying what changes
if you set it otherwise. `.env` is already git-ignored; this is the template.

### 6. `docs/DEPLOY.md` (new)

The document that makes the rest usable:

- **Topology**, drawn, for the two supported arrangements: proxy in a separate
  container, and proxy on the host.
- **The `TRUST_PROXY` contract**, with the 403 failure above written out
  explicitly, plus the matching warning that `TRUST_PROXY=1` and a directly
  reachable app port combine into a spoofable `X-Forwarded-Proto`.
- **A working TLS example.** Caddy is four lines and gets certificates
  automatically; nginx is included for people who already run it.
- **Backup and restore**, both paths (native `pg_dump`, and
  `docker compose exec db pg_dump`), wrapped as `npm run db:backup` and
  `npm run db:restore` so the operator does not have to reconstruct them.
- **Upgrade procedure**: pull, rebuild, migrate, restart.
- **What this deployment is not** — see the section at the end of this plan.

### 7. `.dockerignore` (new)

Without it the build context includes `node_modules`, `dist`, `.git`, and the
git-ignored `DEMO-CREDENTIALS.local.md` — the last of which would be copied into
an image layer. Exclude all four.

### 8. Tests — `tests/deploy.mjs` (new)

Small, but covering the things that would otherwise only be discovered in
production:

- **The trust-proxy contract.** The test client connects over loopback, so with
  the default `TRUST_PROXY=loopback` a request carrying
  `X-Forwarded-Proto: https` must have `req.protocol === 'https'`, and a `POST`
  with `Origin: https://<test host>` must be accepted rather than 403'd. This is
  a direct test of the mechanism the whole plan exists to fix, and it fails
  loudly if someone changes the default later.
- **The inverse.** A mismatched `Origin` still 403s, so the fix has not widened
  the CSRF check into uselessness.
- **`GET /health`** returns 200, since both the image healthcheck and compose
  depend on it and nothing tests it today.

### 9. README

Point at `docs/DEPLOY.md` from the existing "Run with the existing local
PostgreSQL database" and "Share through a tunnel" sections, so the tunnel path
(which still works, unchanged) and the container path are not confused for each
other.

---

## Verification

1. `npm run typecheck` clean, `npm test` still 27/27 plus the new file.
2. `docker compose build` succeeds — proving the pinned base tag exists.
3. `docker compose up -d`, then: `GET /health` returns 200, a signup works over
   the published port, and the dashboard loads and renders the Alerts card.
4. **The one that matters:** put Caddy in front with TLS, then log in and approve
   something through the proxy. If `TRUST_PROXY` is wrong this 403s, which is
   exactly the bug this plan exists to prevent. Demonstrating it working through
   a proxy is the acceptance test.
5. `npm run db:backup`, drop the volume, `npm run db:restore`, confirm the
   workspace is back.
6. Confirm the image contains no `.env`, no `DEMO-CREDENTIALS.local.md`, and no
   `node_modules` dev dependencies: `docker run --rm -it --entrypoint sh <image>`
   and look.

---

## What this deployment still is not

Written into `docs/DEPLOY.md` as well, because a deployment guide that oversells
its result is worse than none:

- **No password reset.** Users cannot recover accounts. Onboarding a real user
  means creating the account for them and accepting that a forgotten password is
  unrecoverable.
- **No email at all**, so no verification, reset, or notification by mail.
- **Single instance.** The watchdog runs inside the app process, so running two
  app containers means two watchdogs doing the same sweep. The row locking in
  `inspectWorkspace` (`FOR SHARE` on the workspace, `FOR UPDATE OF t` on tasks)
  means that is *correct* rather than a race — the second sweep blocks, then
  re-reads and finds nothing left to halt — but it is duplicated work, and it
  makes the deployment's proxy and rate-limiting assumptions harder to reason
  about. Run one app container.
- **Alert delivery is best effort.** No retries, no delivery log, no guarantee.
- **Agent enforcement is cooperative.** An agent that ignores the API is not
  stopped by anything here.
- **No retention or deletion policy.** Nothing expires, nothing is purged, and
  there is no "delete my workspace" path — which is a problem the moment a real
  customer asks.
- **Rate limiting is per socket peer in a shared table**, which is correct for
  one instance and remains correct behind exactly one proxy. It is not a defence
  against a distributed attacker.
