# Project state

Current verified state of the implementation. Design rationale is in [DECISIONS.md](DECISIONS.md); structure is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Development stage

A local-development project, not production-ready and not deployed. All three message sources, the shared deterministic intelligence pipeline, review, duplicate/conflict advisories, safe Calendar creation and conservative automation are implemented. An LLM fallback, production operations (monitoring, CI, deployment) and portfolio media are not implemented.

This repository is a sanitized release candidate created from a separate private development repository, which remains private as the historical archive. It starts from a single fresh commit. The private GitHub migration is complete: this repository is hosted privately on GitHub and is the active development home. It has not been made public; public release is a separate owner-authorized step that has not been performed.

## Capability status

| Capability                                                              | Status          | Live evidence                                                                                                                                      |
| ----------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google sign-in, Gmail selected import, review, manual Calendar creation | Implemented     | Previously accepted against a real Google account and primary calendar, including disconnect/reconnect and repeat-write protection                 |
| Temporal facts, readiness, categories, confidence, review explanations  | Implemented     | Deterministic; covered by unit and integration tests                                                                                               |
| Duplicate and conflict advisories                                       | Implemented     | One bounded real read each previously verified listing/projection and a match or overlap; edge cases are synthetic only                            |
| Outlook selected import                                                 | Implemented     | **Unverified live.** A real organizational sign-in stopped at administrator consent                                                                |
| Discord Follow relay                                                    | Implemented     | Real permission, manual-channel and Gateway handshake checks passed. **Real Follow delivery, source identity and edit/delete behavior unverified** |
| Automation policy, questions, activity, Gmail polling                   | Implemented     | **Live polling and automatic Calendar creation unverified.** No real automatic write has been performed                                            |
| LLM fallback                                                            | Not implemented | —                                                                                                                                                  |

## Verification of this candidate

Run on Windows with Node.js 24.21.0, npm 11.19.0 and PostgreSQL 17, from a clean `npm ci` of the committed lockfile. Providers were synthetic; the database was a new empty disposable `_test` database.

| Check                                      | Result                                           |
| ------------------------------------------ | ------------------------------------------------ |
| `npm run typecheck`                        | Passed                                           |
| `npm run build`                            | Passed (warning: one frontend chunk over 500 kB) |
| `npm test` (unit, API, UI)                 | 443 passed (47 files)                            |
| `npm run db:migrate` (disposable database) | All 5 migrations applied                         |
| `npm run test:integration` (PostgreSQL)    | 227 passed (27 files)                            |
| `npm run test:e2e` (Playwright, Chromium)  | 29 passed                                        |
| `npm run format:check`                     | Passed                                           |

These results show the code builds and its synthetic suites pass. They do not establish live provider compatibility, extraction accuracy, throughput or production security.

## Known limitations

- Gmail polling may miss late-indexed messages outside completed windows; Outlook has no automatic polling.
- Calendar writes are create-only to the primary calendar; no updates, deletions or rescheduling.
- Replay protection covers this application's writes, not simultaneous edits by unrelated Calendar clients.
- `gmail.readonly` is a restricted Google scope; public hosting would require Google verification.
- Expired session and OAuth-state rows are not periodically purged.
- No CI workflow, rate limiting or deployment configuration.
- The frontend bundle is a single chunk over 500 kB.
