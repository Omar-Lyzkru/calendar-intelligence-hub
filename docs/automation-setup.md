# Automation setup and acceptance gates

Read [automation safety](automation-safety.md) first. Automation reuses the shared review, approval and Calendar writer; it adds policy, focused questions and bounded Gmail polling. Everything starts disabled.

Code being present is not the same as a database being migrated. Before running the Discord and automation migrations against a database that already holds meaningful records, make and verify a backup. Preserve the existing `TOKEN_ENCRYPTION_KEY` exactly; never replace `.env` with the template.

## Development and simulation

Node.js 24 and PostgreSQL are sufficient; no additional service is required. Generate the Prisma client and build as described in [setup](setup.md). Tests require a separate PostgreSQL database ending `_test`, with migrations applied there only. Test setup replaces provider credential variables in the test process (not in `.env`) and disables the live-write gate. Unit tests point database access at an unreachable dummy URL. Browser-test provider gateways are synthetic; fake Calendar inserts are not live Google acceptance.

Normal verification:

```sh
npm test
npm run typecheck
npm run build
TEST_DATABASE_URL=<disposable URL> npm run test:integration
TEST_DATABASE_URL=<disposable URL> npm run test:e2e
npm run format:check
```

Never put a meaningful URL into `TEST_DATABASE_URL` or run tests against meaningful data. Integration setup rejects equality with `DATABASE_URL` and requires the `_test` suffix. Browser startup checks only the `_test` suffix, and Playwright overrides `DATABASE_URL`, so it does not provide the equality safeguard. Independently verify that every suite targets a separate disposable database.

## Controls

Activity is the primary workspace. Automation settings expose enabled/off, explicit account/channel/category rules and an independent Gmail polling opt-in. Add a rule deliberately: Auto requires all provenance, duplicate and conflict gates; Ask requests one-time confirmation; Skip records a deliberate decision. One-time confirmation never changes a rule. A mailbox scope means the selected account, not verified identity of every sender. Changes take effect when saved; an action already running may finish while the save waits. Full Review remains available.

Gmail polling reads one bounded ID page per new window per tick and remembers its cursor and pending work. Its separate consent timestamp starts collection; switching polling off and on starts fresh, while an ordinary restart preserves progress. Do not reset watermarks manually to rescan a mailbox. Problems remain visible; resolve authorization or provider issues before using Retry. Outlook polling is inactive. Discord uses only its configured relay.

## Operator gate and first live test

`AUTOMATION_LIVE_WRITES_ENABLED` is optional and defaults to false; the only enabling value is the literal string `true`. It is not exposed through the user API. Leave it absent or false during development.

Before the first real automatic Calendar creation:

1. Back up and verify the database, then apply pending migrations. Check that existing messages, provider authorizations, approvals and receipts are preserved. Do not reset or backfill policies.
2. Keep broad background writes disabled. Prepare exactly one suitable candidate or a deliberately authored test message; do not mutate mail, Discord or provider scopes.
3. Review the candidate's facts, category, policy, provenance, complete duplicate/conflict coverage, revision/source freshness and write intent, without exposing credentials or full private source content.
4. Enable the gate only for that bounded test. Run the one decision through the shared policy, approval and writer; verify one receipt, one Calendar event and no duplicate on rerun, with explained activity.
5. Disable the gate again unless you deliberately intend ongoing automatic creation.

No automatic Calendar creation has been performed against a real account. Live Gmail polling, live Microsoft access and real Discord Follow delivery are not verified; see [project state](PROJECT_STATE.md).
