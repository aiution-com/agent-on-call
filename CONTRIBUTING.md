# Contributing to AgentOnCall

Thanks for helping improve AgentOnCall. Issues and pull requests are welcome.

## Local setup

Use Node.js 24 and PostgreSQL 17. The fastest way to start the app and database
is `docker compose up -d --build`; open `http://127.0.0.1:3000/signup`.

For a local Node.js process, start PostgreSQL with the credentials in
`.env.example`, then run:

```sh
npm ci
npm run migrate
npm test
npm run dev
```

Tests create and remove their own workspaces in the configured database. Use a
development database, never one containing data you need to keep. `npm test`
builds TypeScript and runs the integration suite. `npm run typecheck` checks
types without emitting files.

## Pull requests

### Before opening

- Branch from `main` using a descriptive name: `feature/...`, `fix/...`, `design/...`, or `docs/...`.
- Keep one logical change per pull request. Put refactors, dependency updates, and formatting changes in separate PRs.
- Work from Node.js 24 and PostgreSQL 17. Run `npm ci`, `npm run migrate`, `npm test`, and `npm run typecheck` locally.
- For UI changes, check the affected screens at desktop and mobile widths and attach before/after screenshots. Use fictional data; never include agent keys, secrets, personal data, or real client data.
- If behavior changes, update the README, `docs/USER_GUIDE.md`, and `/help` where they describe the workflow.
- Report vulnerabilities privately using [SECURITY.md](SECURITY.md), not in a public issue or pull request.

### Opening the pull request

- Fill in the pull request template. GitHub loads `.github/PULL_REQUEST_TEMPLATE.md` automatically.
- Use a clear, imperative title, for example `Add webhook signing secret rotation`.
- Link the issue with `Closes #123` when one exists.
- Describe how you verified the change, including commands and manual checks.

### Review and merge

- The `CI/test` check must pass. It runs migrations and the integration suite against PostgreSQL 17.
- A maintainer must review the pull request. CODEOWNERS requests the default maintainer automatically.
- Resolve review conversations before merging.
- Merge with **squash and merge** and delete the branch afterwards. Do not force-push a shared branch.
- Do not merge a change to approval or stop semantics without updating the tests and user documentation that describe it.

## Public API and security notes

The supported public API is mounted in `src/index.ts` and implemented in
`src/workspace-api.ts`. Approval and stop signals rely on connected agents
cooperating with the API. Do not describe them as a sandbox or a guarantee that
unintegrated agents cannot act.

Report vulnerabilities privately using [SECURITY.md](SECURITY.md), rather than
posting exploit details in a public issue.
