# Local setup and Google OAuth

Use your own local database and provider registrations. Current implementation status and Microsoft/Discord/automation limits are documented in [project state](PROJECT_STATE.md). This repository is source code for local development, not a hosted service.

A fresh clone contains no database records or encrypted credentials. If you move an existing installation between machines, transfer its database backup and its `TOKEN_ENCRYPTION_KEY` together through your own private channel; never generate a replacement key for restored state.

**Existing installation:** keep your existing configuration and encryption key; do not overwrite an existing `.env` with `.env.example`, create a new Google project unnecessarily, recreate a database/volume, or run tests against meaningful data. Back up meaningful data before additive migrations or normal startup, which enforces existing source retention.

## 1. Prepare the application and database

Run commands from the repository root. Use Node 24 LTS and npm. The lockfile fixes resolved dependency versions; Prisma is on patched 6.19.3 with audited transitive overrides.

```sh
npm ci
cp -n .env.example .env
```

Edit .env locally. Keep it out of chat, screenshots, commits, and shared logs. Set POSTGRES_PASSWORD, DATABASE_URL, and TEST_DATABASE_URL. The URLs must point to different databases; the test name must end _test. URL-encode special characters in database passwords.

If PostgreSQL already exists, create `calendar_hub` and `calendar_hub_test` under a local database role you control. Alternatively, if Docker is installed:

```sh
docker compose up -d db
```

compose.yaml creates both databases on the initial empty volume and binds port 5432 to loopback. Changing the initialization SQL does not rerun it on an existing volume. Do not delete a database volume to resolve setup problems; inspect the existing database instead.

Generate a 32-byte encryption key directly into .env without printing it:

```sh
node scripts/create-local-key.mjs
```

This keeps an existing nonempty TOKEN_ENCRYPTION_KEY unchanged and writes a newly generated key only when one is absent; it creates no OAuth credentials. Preserve the key once real refresh tokens are stored; changing it makes existing encrypted credentials unreadable and requires reconnecting. Startup also requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, configured in the next section.

## 2. Create the Google Cloud OAuth client

Open the [Google Cloud Console](https://console.cloud.google.com/) in your browser.

1. Create or select a project for Calendar Intelligence Hub.
2. Enable **Gmail API** and **Google Calendar API** in APIs & Services → Library. Google's [Gmail setup](https://developers.google.com/workspace/gmail/api/quickstart/nodejs) and [Calendar setup](https://developers.google.com/workspace/calendar/api/quickstart/nodejs) describe API enablement. Use the web-client flow below for this application.
3. Open Google Auth platform → Branding. Set the application name and your own support/contact email.
4. Under Audience, choose External for a personal Gmail account and keep the app in Testing. Add your own Google account as a test user. Internal is appropriate only if an eligible Workspace organization controls the project/account. Organization-admin restrictions may prevent authorization. Microsoft 365 organizational mail is configured separately.
5. Under Data Access, configure these scopes: `openid`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/userinfo.profile`, `https://www.googleapis.com/auth/gmail.readonly`, and `https://www.googleapis.com/auth/calendar.events.owned`. The application uses equivalent `email` and `profile` aliases for login and requests Gmail/Calendar when you connect each capability.
6. Under Clients, create an OAuth client of type **Web application**.
7. Add the authorized redirect URI **exactly**: `http://localhost:5173/auth/google/callback`.
8. If the form requests an authorized JavaScript origin, use `http://localhost:5173`. The code exchange occurs on the backend; no client secret is used in browser code.
9. Copy the client ID and secret directly into your local .env. Keep downloaded credential JSON outside the repository. Never paste either credential into chat.

The official [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server) describes consent, offline access, redirect registration, and incremental authorization. Gmail body access uses a restricted scope; selecting messages is an application restriction rather than a narrower OAuth grant. Public deployment can require verification/security assessment. Read [Gmail scope requirements](https://developers.google.com/workspace/gmail/api/auth/scopes) before considering public release.

Confirm these local values:

```text
NODE_ENV=development
PORT=3000
APP_ORIGIN=http://localhost:5173
GOOGLE_REDIRECT_URI=http://localhost:5173/auth/google/callback
GOOGLE_CLIENT_ID=<your web client ID>
GOOGLE_CLIENT_SECRET=<your web client secret>
TOKEN_ENCRYPTION_KEY=<64 hex characters generated locally>
```

Do not mix localhost and 127.0.0.1 for the real app; OAuth redirects, cookies, Origin checks, and the browser address must agree. Open **http://localhost:5173**.

## 3. Apply migrations and start

```sh
npm exec prisma generate
npm run db:migrate
npm run dev
```

The backend reads .env and validates required configuration; Vite proxies /api and /auth to the local backend. It purges expired source content at startup. In a second terminal, tests can be run separately.

1. Sign in with Google.
2. Open Connections and connect Gmail and Calendar using the same account.
3. Accept the requested scopes. A declined capability stays unavailable.
4. Confirm the display timezone. New users default to America/Chicago; change it if your commitments use another timezone.
5. Open Messages, select a test announcement, and import it.
6. Open Review queue and check title, evidence, date/time, duration, and location.
7. Save corrections or choose Approve and add. A proposed 60-minute duration requires your checkbox confirmation.

If an authorization screen or callback fails, note the safe error code and request ID; do not share a callback URL containing `code` or `state`. `redirect_uri_mismatch` means the registered URI and .env/browser origin need to match exactly. `scope_not_granted` means reconnect and grant the capability. `account_mismatch` means sign in and authorize the same Google account. `reauthorization_required` means reconnect the relevant capability. A testing consent configuration may require repeated authorization; do not treat testing credentials as permanent deployment credentials.

## 4. Test databases and synthetic browser checks

Create a separate database ending _test. Set TEST_DATABASE_URL privately in your shell. Apply migrations with that URL explicitly assigned to DATABASE_URL **for that command only**:

```sh
DATABASE_URL="$TEST_DATABASE_URL" npm run db:migrate
npm run build
npm run test:integration
npm exec playwright install chromium
npm run test:e2e
```

Do not run this command until TEST_DATABASE_URL is set and checked. The integration and browser guards reject missing test configuration and unsafe database names. Tests insert synthetic records into the test DB and may leave those records for inspection. No live Google calls occur in these suites.

```sh
npm test
npm run typecheck
npm run build
npm run format:check
```

In a sandboxed environment, package downloads and local sockets may need approval. A listen-permission or DNS error is an environment problem, not an application assertion failure.

## 5. Supported extraction and limits

The conservative parser supports full English month names with an explicit day/year and AM/PM times, for example `Workshop October 8, 2026 at 2:00 PM`. A second explicit AM/PM time may supply the end. Titles begin with the message subject; location and description can be entered during review.

Missing years, numeric dates, recurrence, updates/cancellations, multiple dates, relative expressions, and ambiguous daylight-saving local times are unresolved or flagged. A reviewer must explicitly enter one commitment. A date-only announcement is not silently converted to all-day. The all-day end date is exclusive.

Limits: 20 selected message IDs per import; 256 KiB decoded body budget; 300 KiB HTTP JSON limit; finite provider timeout (default 15 seconds, maximum 20); 60-second write claim lease; source content/evidence retention 30 days. Original content expiry is enforced at read time as well as cleanup on startup/import. Review event facts and safe history remain. No attachment processing, remote image loading, or raw HTML rendering.

## 6. Live verification checklist

Prepare your own synthetic test email; the application never sends mail. Suggested body: `Workshop October 8, 2026 at 2:00 PM`. A past date is acceptable for a test; substitute an explicit future date/year if desired.

- [ ] Consent with a designated test account and confirm both connected capabilities.
- [ ] Import only that selected email; check original content and extraction evidence.
- [ ] Correct the duration and approve; verify the event in your actual primary Google Calendar.
- [ ] Re-import and retry creation; confirm one calendar event for this review.
- [ ] Try an ambiguous test announcement; approval must stay unavailable until correction.
- [ ] Disconnect; confirm stored access is disabled; reconnect and confirm authorization works again.
- [ ] Check safe logs contain no bodies, access tokens, refresh tokens, codes, or client secrets.
- [ ] Remove the test event manually in Google Calendar if desired. The application does not delete Calendar events.

Automated mocks do not establish live Google compatibility; only this checklist exercises your real OAuth configuration.

## Timezone and date handling

The display timezone is a preference, not a numeric date-format policy. Standalone timezone abbreviations require reviewer correction. Date-only candidates require explicit all-day confirmation or actual times before approval. Deploy the frontend and backend together; the review form depends on the shared temporal contracts.

## Optional inputs

Google remains the workspace login and Calendar destination. Leave the four Microsoft variables blank for a Gmail-only workspace, or follow the [Microsoft Web registration checklist](microsoft-setup.md) with authorization from your organization. Discord input is configured separately through [Discord setup](discord-setup.md). Credentials stay backend-only in the ignored `.env`. Back up meaningful data before applying migrations to an existing database.
