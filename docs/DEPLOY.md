# Deploying AgentOnCall

One application container in front of one PostgreSQL database, behind a reverse
proxy that terminates TLS. That is the whole topology; there is no supported
multi-instance arrangement.

Everything in this document has been run end to end. Where a configuration was
verified by actually starting it, that is said so — one option below is included
without having been executed, and is marked as such.

---

## Quick start

```bash
cp .env.example .env      # optional; every value has a working default
docker compose up -d
```

That starts the database, waits for it to accept connections, applies the
migrations, and starts the app on `http://127.0.0.1:3000`. First boot looks like:

```
RUN_MIGRATIONS is set; applying migrations before start.
applied 001_initial_schema.sql
applied 002_task_logs.sql
applied 003_accounts.sql
applied 004_alert_channels.sql
AgentOnCall listening on 0.0.0.0:3000
```

Check it:

```bash
docker compose ps                       # both containers should say (healthy)
curl -s http://127.0.0.1:3000/health    # {"ok":true}
```

The app port is published to the host's **loopback only**. Nothing is reachable
from another machine until you put a proxy in front — which is the next step, and
the point at which the one genuinely surprising setting below matters.

---

## `TRUST_PROXY`, and the failure it causes

This is the thing to understand before deploying, because getting it wrong
produces a confusing error that does not mention proxies.

The app defends against CSRF by comparing the browser's `Origin` header against
`${req.protocol}://${req.get('host')}`. `req.protocol` is `https` **only when the
proxy that terminated TLS is trusted** to say so. If it is not trusted, the app
believes the scheme was `http`, the comparison fails, and every mutating request
— sign in, approve, reject, save an alert destination — is refused with:

```
{"error":"Request origin is not allowed."}
```

which reads like a CSRF bug rather than a configuration mistake.

`TRUST_PROXY` therefore has to match the topology:

| Topology | Set | Why |
|---|---|---|
| No proxy at all | `false` | Nothing should be allowed to assert a scheme. |
| Proxy on the same host, e.g. `cloudflared` | `loopback` *(default)* | The proxy connects over loopback. |
| Proxy in its own container | `1` | Exactly one hop in front of the app. |
| Proxy on a known subnet | `172.16.0.0/12` or a comma-separated list | Narrower than a hop count. |

**Verified behaviour.** With a Caddy container terminating TLS in front:

| `TRUST_PROXY` | `POST /api/auth/login` through the proxy |
|---|---|
| `loopback` (default) | `403 {"error":"Request origin is not allowed."}` |
| `1` | `401 {"error":"Email or password is incorrect."}` — the origin check passed and it reached credential validation |

So if sign-in fails in a deployment with a correct password, check this setting
first.

> **Warning.** `TRUST_PROXY=1` trusts the scheme asserted by whatever connects.
> It is only safe while the app port is **not** directly reachable. The compose
> file binds it to `127.0.0.1`, which is what makes this safe. Publishing
> `0.0.0.0:3000` at the same time would let any client claim `X-Forwarded-Proto:
> https` and satisfy the origin check from anywhere.

---

## TLS

### Caddy — verified

Caddy obtains and renews certificates itself, which is why it is the recommended
front end. Two files:

```yaml
# docker-compose.proxy.yml
services:
  proxy:
    image: caddy:2-alpine
    restart: unless-stopped
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    ports:
      - "80:80"
      - "443:443"
    networks: [edge]

volumes:
  caddy-data:

networks:
  edge:
    external: true      # the network created by docker-compose.yml
```

```
# Caddyfile
agents.example.com {
	reverse_proxy app:3000
}
```

Then in `.env`:

```
TRUST_PROXY=1
```

```bash
docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d
```

Caddy sets `X-Forwarded-Proto` on its own, so nothing else is needed. With
`tls internal` instead of a public hostname, Caddy issues from its own CA — that
is the arrangement used to verify the table above, and it is the right choice for
a private deployment or a staging box.

### nginx — not executed

Included for completeness; **this specific configuration has not been run.** The
line that matters is `X-Forwarded-Proto`, and omitting it produces exactly the
403 described above.

```nginx
server {
    listen 443 ssl;
    server_name agents.example.com;

    ssl_certificate     /etc/letsencrypt/live/agents.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/agents.example.com/privkey.pem;

    location / {
        proxy_pass http://app:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Migrations

Migrations are an explicit, ordered list in `scripts/migrate.mjs`. Each runs in
its own transaction under a Postgres advisory lock, so running it twice, or from
two processes at once, is safe.

- **On first boot**, `docker-compose.yml` sets `RUN_MIGRATIONS=1` so a fresh
  database just works.
- **For a schema change**, run it deliberately rather than relying on a restart:

```bash
docker compose run --rm app node scripts/migrate.mjs
```

It prints `applied <name>` or `skip <name> (already applied)` for each.

To add one: create `migrations/005_whatever.sql`, add its filename to the array
in `scripts/migrate.mjs`. Never edit a migration that has already been applied.

---

## Backup and restore

```bash
npm run db:backup                                    # backups/agentoncall-<timestamp>.dump
npm run db:backup -- /path/to/name.dump
```

The script uses `pg_dump` from `PATH` when it can reach `DATABASE_URL`, and
otherwise runs it inside the database container — so it works whether or not
PostgreSQL client tools are installed on the host. It refuses to write an empty
file.

```bash
docker compose stop app                 # pg_restore needs to drop tables
npm run db:restore -- backups/agentoncall-2026-10-03T10-16-06-441Z.dump --yes
docker compose up -d app
```

Restore **drops and recreates** objects, so it discards whatever is in the
database now. It refuses to run without `--yes`. Stop the app first, or
`pg_restore` will block on tables the app is holding open.

**Verified:** backing up, then inserting a row and renaming a workspace, then
restoring, put both back to their backed-up state — the inserted row was gone and
the renamed workspace had its original name.

Backups are written to `backups/`, which is git-ignored. Nothing schedules them;
put `npm run db:backup` in cron if you want them automatic, and copy the output
somewhere other than the machine it backs up.

---

## Upgrading

```bash
git pull
docker compose build app
docker compose run --rm app node scripts/migrate.mjs
docker compose up -d
```

The database lives in the `db-data` volume and is untouched by a rebuild. Take a
backup first if the release contains a migration.

---

## What this deployment is not

Stated plainly so that nothing here is mistaken for a guarantee:

- **No self-service password reset.** There is no email, so a locked-out user
  cannot recover an account on their own. A signed-in operator can change their
  password in Settings. From the host, with the app's `DATABASE_URL`:

  ```sh
  AOC_EMAIL=user@example.com AOC_NEW_PASSWORD='at-least-12-characters' \
    node scripts/reset-password.mjs
  ```

  This sets the password and signs out every session. Host access is therefore
  equivalent to account takeover; protect it accordingly.
- **No email.** No verification, no reset, no notifications by mail.
- **Single instance.** The watchdog runs inside the app process. Two app
  containers means two watchdogs — correct, because the row locking in
  `inspectWorkspace` prevents double-halting, but duplicated work, and it makes
  the proxy reasoning above harder to hold in your head. Run one.
- **No TLS in the app.** Terminate at the proxy. The session cookie is marked
  `Secure` whenever the request arrives over HTTPS, which depends on
  `TRUST_PROXY` being right.
- **Alert delivery is best effort.** Sent once. No retries, no delivery log.
- **Agent enforcement is cooperative.** An agent that ignores the API is not
  stopped by anything here.
- **No retention or deletion policy.** Nothing expires, nothing is purged, and
  there is no "delete my workspace". Required before real customer data.
- **Rate limiting is per socket peer**, recorded in a shared table. Correct
  behind exactly one proxy; not a defence against a distributed attacker.
- **No monitoring, metrics, or log aggregation.** `docker compose logs` is the
  whole observability story.
