## What changed

<!-- One or two sentences. What does this pull request do? -->

## Why

<!-- The problem, issue, or user need. Link the issue if one exists: Closes #123 -->

## Scope

- [ ] Feature
- [ ] Bug fix
- [ ] UI / design
- [ ] Documentation
- [ ] Security or access control
- [ ] Deployment or infrastructure

## Verification

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] Manual check of the affected screens at desktop and mobile widths
- [ ] Screenshots attached for UI changes, using fictional data only

## Risk

<!-- What could break? How can a reviewer verify the change or roll it back? -->

## Checklist

- [ ] One logical change per pull request; unrelated cleanup is in its own PR
- [ ] No agent keys, secrets, personal data, or real client data in code, logs, or screenshots
- [ ] Public API, README, `docs/USER_GUIDE.md`, and `/help` updated if behavior changed
- [ ] Approval and stop behavior is described as cooperative, not as a sandbox or a guarantee
- [ ] Database migrations are additive and were run against a local database

<!--
  Merge only after CI is green and a maintainer has reviewed.
  Prefer squash merges. Do not force-push a shared branch.
-->
