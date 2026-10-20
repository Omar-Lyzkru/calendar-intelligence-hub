# Microsoft Outlook setup

**The Outlook adapter is implemented; live Microsoft compatibility is unverified.** Automated checks use synthetic Microsoft and Google responses. A maintainer's sign-in attempt against an organizational tenant stopped at "Need admin approval", so no successful live OAuth, Graph listing or message import has been observed.

## Minimal user/administrator setup

1. In the intended organizational tenant, confirm you can register an application or ask its administrator to provide one. Do not create a personal tenant to bypass organizational policy. Register **single tenant / accounts in this organizational directory only**. This implementation supports the global Microsoft cloud and one configured tenant, not personal accounts or arbitrary tenants.
2. Add an Authentication platform of **Web** with the exact development redirect URI `http://localhost:5173/auth/microsoft/callback`. This follows the repository default `APP_ORIGIN=http://localhost:5173`: Vite forwards `/auth` to the Express backend on port 3000. If the local origin changes, the redirect must be exactly that origin plus `/auth/microsoft/callback`. Production requires HTTPS. The browser does not exchange tokens: do not choose SPA/Desktop, enable implicit grants or enable public-client flows.
3. Add Microsoft Graph **delegated Mail.Read**, not an application permission. Remove default delegated User.Read if present; this code does not call a profile endpoint. The actual authorization request also contains MSAL's `openid`, `profile` and `offline_access` identity/refresh scopes. No Microsoft Calendar, mail write/send, directory, Files, Teams, contacts or shared-mailbox permission is needed. Organizational policy may require administrator consent even though delegated Mail.Read is listed as not inherently requiring admin consent. Do not add broader permissions to work around a denial.
4. Obtain the Application (client) ID and Directory (tenant) ID from your registration. Create a client credential using your organization's approved process. Enter the client secret **value** directly into the backend's ignored local `.env`, never into chat, screenshots, docs or Git. Keep the existing Google configuration and encryption key. Set all four variables below together; leaving all four blank keeps Outlook disabled. Never change the encryption key casually: existing encrypted credentials depend on it.
5. Ensure the normal additive database migrations have been applied to your chosen local development database using `npm run db:migrate`, after backing up meaningful data. Implementation verification applied migrations only to a fresh synthetic test database; it did not migrate existing user data. Start the app with `npm run dev`, open `http://localhost:5173`, sign into the existing Google workspace, then choose Connections → Connect Outlook. You perform the Microsoft sign-in and consent. Stop if organizational policy denies access; Gmail and existing reviews remain available.

```dotenv
MICROSOFT_CLIENT_ID=
MICROSOFT_TENANT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_REDIRECT_URI=http://localhost:5173/auth/microsoft/callback
```

The default frontend is `http://localhost:5173`; the backend binds `http://127.0.0.1:3000`. No browser Microsoft SDK, authorized JavaScript origin or browser-held Microsoft credential is used. The backend uses the confidential authorization-code flow with S256 PKCE, state and nonce. A public client would change the existing server-side trust model rather than eliminate setup safely.

## Permissions and access limits

| Scope                                   | Purpose                                                   | Kind            | Admin consent                                  |
| --------------------------------------- | --------------------------------------------------------- | --------------- | ---------------------------------------------- |
| `https://graph.microsoft.com/Mail.Read` | Read selected message bodies; Mail.ReadBasic omits bodies | Delegated Graph | Microsoft lists No; tenant policy can override |
| `openid`                                | Identity authentication                                   | OIDC            | Subject to tenant consent policy               |
| `profile`                               | Stable tenant/object account claims; no profile API call  | OIDC            | Subject to tenant consent policy               |
| `offline_access`                        | Refresh without repeated interactive sign-in              | OIDC            | Subject to tenant consent policy               |

Mail.Read grants mailbox-reading capability, even though this application limits each list to 20 subject/timestamp records and fetches bodies only for selected imports. It does not limit OAuth permission to selected messages. Microsoft cache tokens remain encrypted on the backend. Only tenant/object IDs needed for connection management are explicitly stored; no Microsoft email/display-name/profile fields are persisted separately. The SDK's serialized credential cache may contain identity claims and is encrypted as a whole.

## Read-only live acceptance after setup

Choose an existing suitable message; import it once and inspect original source label, extracted facts, temporal interpretation, readiness, category, confidence and explanation. Check local/Google duplicate and conflict advisories. These operations read providers and write only local review data. Do **not** approve/add to Calendar for this read-only acceptance. Repeat import to check local source identity, then optionally disconnect Outlook locally and confirm review history/Gmail still work. Record only pass/fail categories and counts; exclude subject/body, account IDs, provider IDs, private URLs, raw responses and credentials from evidence.

Tenant permission denial, missing Exchange mailbox/licensing, Conditional Access, publisher restrictions or redirect mismatch remain possible until tested by the user. Do not bypass them or reconnect repeatedly. A 429 shows bounded Retry-After guidance; wait before manually retrying. Pagination cursors expire after ten minutes and after credential generation changes; return to the first page if stale. There is no background ingestion, attachment fetching, shared/archive mailbox support or Microsoft Calendar destination.

Disconnect erases local Microsoft credentials and cancels pending callbacks; it preserves imported history. It does not revoke Microsoft consent. Remove application consent through Microsoft/organization account controls if desired, with administrator assistance where required; the app does not request broad session-revocation permissions.

## Current Microsoft references

Checked October 12, 2026: [registration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app), [redirect URI rules](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url), [authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [OIDC scopes](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc), [delegated Mail.Read](https://learn.microsoft.com/en-us/graph/permissions-reference#mailread), [message listing](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0), [immutable IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id).
