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

Describe the behavior you changed and how you verified it. Keep changes focused.
For changes to the API or dashboard, update the README or user guide as needed.
If you change `/help`, update `docs/USER_GUIDE.md` too; they describe the same
user workflow.

The supported public API is mounted in `src/index.ts` and implemented in
`src/workspace-api.ts`. Approval and stop signals rely on connected agents
cooperating with the API. Do not describe them as a sandbox or a guarantee that
unintegrated agents cannot act.

Report vulnerabilities privately using [SECURITY.md](SECURITY.md), rather than
posting exploit details in a public issue.
