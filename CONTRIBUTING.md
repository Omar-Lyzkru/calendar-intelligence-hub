# Contributing

This is an AI-assisted local-development project. Read the [README](README.md), [architecture](docs/ARCHITECTURE.md), [project state](docs/PROJECT_STATE.md), [safety invariants](docs/automation-safety.md) and [security policy](SECURITY.md) first.

## Changes and review

Discuss material product/security changes before implementation. Keep changes focused; explain the problem, resulting behavior and verification. Disclose relevant AI assistance and distinguish implementation from specification/review work. Preserve no-duplicate/no-invented-facts/privacy requirements. Use synthetic fixtures with clearly fictional identities; do not copy provider payloads, messages, screenshots, tokens or private event data from an account.

Use your GitHub-provided noreply email for future commits if you want commit-email privacy. Changing that setting does not remove addresses already present in Git history. See GitHub's [commit-email guidance](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address).

## Development setup

Use Node.js 24 and PostgreSQL. Run `npm ci` and `npm exec prisma generate`. Follow [setup](docs/setup.md) for a fresh local application, keeping `.env` ignored. Preserve existing encryption keys/configuration. Back up meaningful data and obtain authorization before applying migrations to an existing installation.

## Synthetic verification

Create a separate disposable database whose name ends `_test`. Set TEST_DATABASE_URL in the test process to its PostgreSQL URL; do not share it or use the meaningful application URL. The integration setup rejects equality with its original DATABASE_URL and requires the `_test` suffix. The browser harness checks only the `_test` suffix; Playwright replaces DATABASE_URL before startup, so do not rely on an equality guard for browser tests. Independently verify that every suite targets a separate disposable database containing no meaningful data.

Apply migrations only to the disposable database, then run:

```sh
DATABASE_URL="$TEST_DATABASE_URL" npm run db:migrate
npm test
npm run typecheck
npm run build
npm run test:integration
# Install Chromium once if absent:
npm exec playwright install chromium
npm run test:e2e
npm run format:check
git diff --check
npm audit
```

TEST_DATABASE_URL must be exported for the integration/browser commands. Recheck the selected server/database before each suite; the browser suffix check cannot prove that its contents are disposable. The first migration command supplies DATABASE_URL only to that command; do not export both variables to the same value for integration tests. Test setup replaces provider credential fields and disables live automatic writes. Browser/integration providers are synthetic; no real Google/Microsoft/Discord account is required. There is no separate lint script; typecheck and Prettier are the current static checks.

Keep ignored logs, database archives, test-results and browser reports local. Inspect any output before sharing it. A passing test suite is not a public-release privacy review, a live acceptance result or permission to call a real provider.

## External effects

Do not create real Calendar events, mutate mail/Discord, change scopes, revoke connections, deploy migrations or change repository visibility as part of routine verification. First live autonomous Calendar acceptance requires separate exact-candidate approval. No automatic event updates/deletes are supported.
