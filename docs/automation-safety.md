# Deterministic automation and safety

Permanent priorities: **NO DUPLICATES. NO INVENTED FACTS. PRIVACY FIRST. AUTOMATION SECOND.** These are implementation requirements, not claims of production accuracy or a guarantee about unrelated Calendar clients.

## Separate intelligence, policy and action

Existing provider adapters normalize messages; the shared deterministic extractor/readiness/category/confidence/advisory pipeline supplies facts. `packages/contracts/src/automation.ts` evaluates typed policy independently of providers, UI or transport. Decisions are `auto_handle`, `ask_user`, `skip`, `blocked`, with fixed reason codes. Confidence is explanation of original extraction, never permission.

`application/automation/engine.ts` loads owned persisted facts, obtains fresh shared duplicate/conflict checks, verifies current policy/review/source versions and persists compact evidence. Only then may it call the existing immutable approval and Calendar writer. There is no second provider writer. `approveAutomatically` validates the saved decision, snapshot hash, fresh checks, active source and version inside its transaction.

## Defaults and permission

An existing user has no policy until first read, which atomically initializes a disabled policy. Rules and Gmail polling default empty/off; enabling creates a new opt-in time. Pre-opt-in received/ingested candidates remain manual, and migration does not backfill or approve them. Re-enabling starts a fresh collection window. Independent Gmail polling consent uses its own persisted gmailPollingEnabledAt; first opt-in and off/on reenrollment cannot start from an older action opt-in. Ordinary restart retains the existing cursor.

Rules are constrained source-connection/category actions, optionally narrowed to a configured Discord channel. They are account/channel scopes, not authentication of every email sender. Skip wins over Ask, which wins over Auto. No match asks. No arbitrary expressions or natural-language tool execution.

Automatic eligibility requires meaningful title, complete valid temporal facts, acceptable explicit or revision-bound user-confirmed provenance, a classified/confirmed category, an explicitly allowing rule and enabled policy, active owned source, unchanged versions, complete untruncated duplicate/conflict coverage, no unresolved possible duplicate or conflict and the existing idempotent write boundary. Assumed zones, date-only interpretation, missing years/ends, ambiguity and erased evidence require focused confirmation/correction. Optional location/description are never required. Exact protected receipts cannot be overridden to create a replacement.

An Ask/unmatched rule may instead offer **one-time user authorization** after facts/checks are complete. This never changes the rule or enables future automatic actions. Permission is tied to the owned answered question and current policy/source/review versions; approval/history identify the user. Duplicate/conflict overrides are likewise explicit and tied to fresh match fingerprints. These are not counted as autonomous policy approvals. Skip rules remain authoritative; full manual Review remains available.

The operator `AUTOMATION_LIVE_WRITES_ENABLED` gate defaults absent/false and is not editable through the API. Keep it false until the first bounded live-write test is explicitly authorized. That first test must target exactly one sanitized, agreed candidate without starting broad background writes. Do not enable the global gate merely to prepare acceptance. No real autonomous write has been performed in this implementation work.

## Questions and activity

Questions ask for title, date, interval/timezone, all-day interpretation, facts, duplicate/conflict decision or one-time permission. Known dates/necessary commitment facts are visible; missing facts remain empty. Answers cannot submit arbitrary fields. A shared database transaction applies draft correction/ignore, answer state, confirmations and history together; a failed state write rolls everything back. Policy/source/candidate changes invalidate old answers and clear stored confirmation fields/fingerprints, preventing later decision refresh from reviving them. Prompt reason is fingerprinted so a general fact prompt cannot become permission silently.

Activity separates recent handled items, Needs you, deliberate skips and problems. It explains source/category/checks and one-time user decisions with validated codes. Original completed-action evidence survives repeated receipt checks. Invalid local receipt associations become investigation problems; they cannot create replacement writes. Persisted Discord source-change notices surface attention even after creation, preserving original approvals/receipts; full Review confirms the source decision. No Calendar update, cancellation, rescheduling or deletion is inferred.

## Replay, races and recovery

Source identity remains connection + external message ID. Real-world duplicate matching remains separate advisory intelligence across Gmail/Outlook/Discord. A user-scoped PostgreSQL advisory transaction lock serializes automatic checks/actions and manual Calendar creation across processes. Reentrant context prevents self-deadlock; a separate max 4 pg lock pool prevents queued waiters exhausting Prisma's pool. Poll locks are released before action evaluation. Idle pool errors emit only a fixed code; replacement connections recover, and loss of an active lock blocks the pre-insert assertion. Candidate edits/source changes still use revision/row guards. Policy saves serialize with actions; an already-running action may finish while settings save, and disabling prevents later actions after save completes.

The shared writer freezes an approved snapshot, persists one provider ID/payload/hash/lease/claim token and uses the same intent on retries. A lost response is unknown, not added; recovery reads the saved ID first and validates its association. The current owned validated intent's exact Calendar ID is excluded from self-advisories, while the writer still validates the fetched hash and unrelated IDs remain advisory. Expired leases recover without a second insert; stale claim tokens cannot finalize a newer claim. A policy/source/revision race blocks stale authorization. A request already in flight cannot be undone.

Google Calendar has no atomic transaction spanning this app and independent external clients. Fresh bounded reads plus project serialization/replay protection do not guarantee prevention of simultaneous edits/creations by unrelated applications. Possible semantic matches require judgment; explicit user decisions remain distinct from exact identity protection.

## Scheduling and collection

The local runtime ticks every 60s, sequentially handling at most 20 due connections and 20 local candidates per tick. A Gmail opt-in uses persisted watermark, fixed <=1h window, at most 20 IDs/one page per run, next-page token and <=20 pending IDs. There is no full-mailbox rescan. Gmail epoch query bounds may overlap a fraction of a second; exact source identity and post-opt-in eligibility prevent replay/new-write mistakes. Pending IDs/cursors survive restart. Partial failure does not advance the watermark past unresolved work. Rate/auth/outage failures remain visible, use capped exponential backoff and pause after five failures (auth failure can pause immediately); explicit retry resumes the stored window.

Per-connection database locking prevents overlapping schedulers processing the same window. Stop/disconnect/policy checks prevent subsequent reads; a body finishing after stop is discarded before normalization/persistence. Provider reads are GET-only. Decision discovery is local and independent of polling. Discord keeps the existing Gateway; Outlook retains selected imports and local decision evaluation, with automatic Graph polling explicitly inactive pending a justified/authorized bounded transport. No new OAuth scopes, mailbox mutation, Discord writes, attachments or notification service. These bounded tests do not establish production throughput or complete Gmail indexing coverage; late-indexed messages outside completed windows may be missed.

## Privacy and storage

Four additive models: AutomationPolicy, AutomationDecision, AutomationQuestion, IngestionPoll. Existing provider authorizations/messages/approvals/receipts/history are preserved; migration upgrade is tested. Decisions retain fixed codes, applicable rule/version, category/provider, provenance confirmation fields, check coverage and immutable action proof. Advisory questions retain at most 5 necessary commitment title/interval summaries, cleared by later decision states; no full original source body or provider payload is copied for explanation. Questions store status/versions and fingerprints, not raw answers duplicating source text. Necessary user corrections live in the existing draft.

Existing 30-day retention, erasure and authenticated credential encryption remain. Logs contain fixed codes/request IDs/counts, never tokens, cookies, OAuth codes, credential caches, raw errors or provider bodies. `.env` and private backups remain ignored/untracked; the active encryption key is not modified/copied. Unit, PostgreSQL and browser runners explicitly isolate provider credential environment so Prisma's automatic ignored-configuration loading cannot supply live credentials during post-merge tests. Unit tests use an unreachable dummy database; integration requires a separate `_test` database.

## Verification and gates

All provider/action data in automated tests is synthetic. Local PostgreSQL, HTTP, browser, encryption and independent-process locking are real. Coverage includes 100 source replays, 100 concurrent action evaluations, overlapping schedulers, manual/auto race, lost responses, expired leases, failed/partial reads, stale answers/policies/sources, question rollback, erased evidence, source edits after creation and shared three-provider advisories. Current results are recorded in [project state](PROJECT_STATE.md).

Applying the Discord and automation migrations to a database that already holds meaningful data requires a verified backup first. Do not run code that needs those tables against a database where they have not been applied.

Live Microsoft compatibility is UNVERIFIED: the tested organizational tenant required administrator consent. Real Discord Follow delivery, source identity and edit/delete behavior are PENDING; permission, manual-channel and Gateway smoke checks are not Follow acceptance. Live bounded Gmail polling and the first automatic Calendar creation are PENDING. There is no LLM fallback.
