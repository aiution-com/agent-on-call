# Security policy

AgentOnCall is an early-stage, self-hosted project. The operator should place it
behind HTTPS, protect the database, and give each integration its own revocable
agent key. See [docs/DEPLOY.md](docs/DEPLOY.md) for deployment details.

To report a suspected vulnerability after this repository is public, use
GitHub's **Report a vulnerability** option on its Security tab. Maintainers
must enable private vulnerability reporting before publication. Include
affected versions, steps to reproduce, and expected impact. Please do not
publish exploit details in a public issue before maintainers have had a chance
to respond.

Security fixes are made on the active development branch. There is no separate
long-term support branch or guaranteed response time yet.

AgentOnCall's approval and stop controls are cooperative: an agent that ignores
the API cannot be physically stopped by this service.
