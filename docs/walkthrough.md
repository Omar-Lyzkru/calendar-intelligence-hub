# Code walkthrough

Read one path through the system instead of memorizing every file. Backend paths below are relative to `apps/api/src/`.

## 1. Input adapters make sources replaceable

`infrastructure/google/gmail.ts` lists metadata and fetches selected full messages. `mime.ts` validates the provider payload and converts it into a NormalizedMessage. This isolates Gmail's MIME structure, identifiers, and network calls from the rest of the application.

The tradeoff is an explicit conversion step. The benefit is that other adapters return the same representation without duplicating the event-processing pipeline: `infrastructure/microsoft/normalize.ts` converts Outlook messages and `infrastructure/discord/normalize.ts` converts relayed Discord announcements.

## 2. Pure domain functions make decisions explainable

`application/processMessage.ts` orchestrates `domain/events/classify.ts` and `extract.ts`. These functions use text and timezone values, not database connections or Google clients. Classification records keyword evidence; Phase 2A extraction separates date, clock, and timezone evidence from subject/body. Explicit complete dates and unique numeric orders resolve; missing years, locale-ambiguous numeric dates, conflicting evidence, and unsupported zone labels remain unresolved. New candidates use extraction version 2.

`validate.ts` requires a calendar-ready title and time interval. A TypeScript type helps developers; runtime schemas validate actual network inputs. Conservative parsing intentionally misses some natural-language cases, keeping errors visible to a human rather than assigning invented confidence.

## 3. Persistence records facts and decisions separately

`persistence/messages.ts` atomically saves the message, candidate, review, processing attempt, and history. The connection/external-message unique constraint handles repeated imports; it does not detect two different messages announcing the same event.

`ReviewItem.draft` is the reviewer working copy; `DetectedEvent.candidate` preserves extraction evidence; `approvedSnapshot` is the frozen calendar-write input. This separation prevents a later import or browser edit from silently changing a decision already approved.

`approveReview.ts` checks both revision and status in the write condition. Two tabs can show the same review, but only the one with the current revision can save or approve it. This is optimistic concurrency: ordinary edits stay simple and stale edits receive an explicit conflict.

## 4. External writes need recovery, not a giant transaction

`persistence/calendarWrites.ts` locks a review row briefly to claim one durable write intent. It stores the provider event ID, approved payload hash, claim token, and lease. Network work occurs after the transaction finishes.

`createCalendarEvent.ts` checks the saved ID before insertion. If an insertion succeeded but its response was lost, a retry can find and confirm the matching event. A hash checks actual commitment fields; an ID collision alone is not success. A claim token prevents an expired worker's late response from overwriting a newer claim's state.

PostgreSQL and Google cannot participate in one local transaction. Keeping the DB transaction open during a network call would occupy locks while still failing to make Google and the DB atomic. This design provides application replay protection, not a global exactly-once guarantee or semantic duplicate detection.

## 5. Authentication and authorization have different jobs

Google identity creates a server-side session. The browser holds an opaque HttpOnly cookie; the database stores its hash. OAuth state binds a callback to the initiating session, nonce binds the ID token to the flow, and PKCE binds the code exchange. CSRF protection separately checks ordinary mutation requests.

Gmail/Calendar scopes authorize capabilities. Refresh tokens are encrypted with a key outside the database; the browser receives no Google credentials. A revoked refresh token marks the connection as requiring reauthorization.

The tradeoff is managing both sessions and provider authorization. They cannot be collapsed into “a token in localStorage” without changing the security boundary.

## 6. Dates and instants need separate types

A timed event has UTC start/end instants plus the timezone used to interpret local input, with optional explicit/assumed/user-confirmed provenance. Legacy records retain absent provenance. An all-day event has calendar dates and an exclusive end date. Converting an all-day date to midnight UTC can move the displayed day in another timezone.

A `date_only` draft preserves known dates without manufacturing midnight. The reviewer explicitly confirms an all-day event (inclusive last date becomes an exclusive end) or supplies actual times. An `unresolved` draft can retain bounded partial facts, including a missing-year date; no year is inferred.

The review form converts local input with shared Temporal primitives and real IANA rules. Normal times need no occurrence selector. Repeated times expose independent first/second choices with actual offsets, preserving saved occurrences when reopened. Nonexistent spring-forward times require correction for every choice. A missing end is not inferred. The optional elapsed 60-minute proposal still requires confirmation.

The same readiness validation is used in review, backend approval, and new/retried write claiming. Calendar serialization independently rejects invalid runtime input. Provider receipts require valid explicit-offset instants or real calendar dates, consistent endpoints, and a positive interval; normalization preserves existing valid hashes. Existing added replays return their saved receipt, with no reserialization. No SQL migration or re-extraction of imported records is required. Deploy frontend/backend together.

## 7. Tests prove different things

- Unit tests prove deterministic processing, payload mapping, contracts, and UI behavior.
- PostgreSQL integration tests prove actual constraints, transaction behavior, ownership, revision handling, retention, and recovery using synthetic provider boundaries.
- Browser tests prove the assembled frontend/API/database path with synthetic Google gateways.
- The live checklist alone verifies real OAuth configuration and Google API compatibility.

Describe what you actually ran. Do not turn a synthetic gateway's “added” response into a claim of verified Google integration.
