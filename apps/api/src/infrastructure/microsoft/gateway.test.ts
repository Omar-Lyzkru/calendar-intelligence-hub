import { it, expect, vi, afterEach } from "vitest";
import { microsoftGateway, microsoftError } from "./gateway.js";
const tenant = "22222222-2222-4222-8222-222222222222",
  account = "33333333-3333-4333-8333-333333333333",
  clientId = "11111111-1111-4111-8111-111111111111";
const config = {
  NODE_ENV: "test" as const,
  PORT: 3000,
  APP_ORIGIN: "http://localhost:5173",
  DATABASE_URL: "postgresql://synthetic@localhost/hub_test",
  GOOGLE_CLIENT_ID: "synthetic",
  GOOGLE_CLIENT_SECRET: "synthetic",
  GOOGLE_REDIRECT_URI: "http://localhost:5173/auth/google/callback",
  TOKEN_ENCRYPTION_KEY: "1".repeat(64),
  PROVIDER_TIMEOUT_MS: 1000,
  MICROSOFT_CLIENT_ID: clientId,
  MICROSOFT_TENANT_ID: tenant,
  MICROSOFT_CLIENT_SECRET: "synthetic-only",
  MICROSOFT_REDIRECT_URI: "http://localhost:5173/auth/microsoft/callback",
};
const authority = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
function fakeMicrosoft() {
  const forms: URLSearchParams[] = [];
  let denied = false;
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    let body: unknown;
    if (url.includes("/discovery/instance"))
      body = {
        tenant_discovery_endpoint: `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`,
        metadata: [
          {
            preferred_network: "login.microsoftonline.com",
            preferred_cache: "login.windows.net",
            aliases: ["login.microsoftonline.com", "login.windows.net"],
          },
        ],
      };
    else if (url.includes(".well-known/openid-configuration"))
      body = {
        authorization_endpoint: authority + "/authorize",
        token_endpoint: authority + "/token",
        issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
        jwks_uri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
        end_session_endpoint: authority + "/logout",
      };
    else if (
      new URL(url).origin + new URL(url).pathname ===
      authority + "/token"
    ) {
      const form = new URLSearchParams(options!.body as string);
      forms.push(form);
      if (denied)
        return new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "synthetic private response",
          }),
          { status: 400 },
        );
      // Deliberately unsigned synthetic token-endpoint fixture; never a real credential.
      const part = (v: unknown) =>
        Buffer.from(JSON.stringify(v)).toString("base64url");
      const idToken =
        part({ alg: "RS256", typ: "JWT" }) +
        "." +
        part({
          tid: tenant,
          oid: account,
          sub: "synthetic-sub",
          iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
          aud: clientId,
          nonce: "synthetic-nonce",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        }) +
        ".synthetic-signature";
      body = {
        token_type: "Bearer",
        scope: "Mail.Read openid profile offline_access",
        expires_in: 3600,
        access_token: "synthetic-access-only",
        refresh_token:
          form.get("grant_type") === "refresh_token"
            ? "synthetic-rotated-only"
            : "synthetic-refresh-only",
        id_token: idToken,
        client_info: part({ uid: account, utid: tenant }),
      };
    } else throw Error("unexpected synthetic endpoint");
    return new Response(JSON.stringify(body));
  });
  return {
    forms,
    deny: () => {
      denied = true;
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("real MSAL builds tenant-specific code/PKCE URL with only approved delegated/OIDC scopes", async () => {
  fakeMicrosoft();
  const url = new URL(
    await microsoftGateway(config).authorizationUrl({
      state: "synthetic-state",
      nonce: "synthetic-nonce",
      code_challenge: "synthetic-challenge",
    }),
  );
  expect(url.origin + url.pathname).toBe(authority + "/authorize");
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBe("synthetic-challenge");
  expect(url.searchParams.get("state")).toBe("synthetic-state");
  expect(new Set(url.searchParams.get("scope")!.split(" "))).toEqual(
    new Set([
      "https://graph.microsoft.com/Mail.Read",
      "openid",
      "profile",
      "offline_access",
    ]),
  );
  expect(url.toString()).not.toContain("synthetic-only");
});
it("real MSAL token exchange/cache refresh preserves rotated refresh credential", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = fakeMicrosoft(),
    gateway = microsoftGateway(config);
  const first = await gateway.exchange(
    "synthetic-code",
    "synthetic-verifier",
    "synthetic-nonce",
  );
  expect(first.refreshCapable).toBe(true);
  expect(first.identity.accountId).toBe(account);
  expect(f.forms[0].get("code_verifier")).toBe("synthetic-verifier");
  expect(f.forms[0].get("client_secret")).toBe("synthetic-only");
  vi.setSystemTime(Date.now() + 3601000);
  const refreshed = await gateway.access(first.cache, account);
  expect(refreshed.cache).toContain("synthetic-rotated-only");
  expect(refreshed.accessToken).toBe("synthetic-access-only");
  expect(f.forms[1].get("grant_type")).toBe("refresh_token");
  vi.setSystemTime(Date.now() + 3601000);
  f.deny();
  await expect(gateway.access(refreshed.cache, account)).rejects.toMatchObject({
    code: "microsoft_reauthorization_required",
  });
});
it("real MSAL rejects token-endpoint nonce mismatch and wrong cached account", async () => {
  fakeMicrosoft();
  const gateway = microsoftGateway(config);
  await expect(
    gateway.exchange("synthetic-code", "synthetic-verifier", "wrong-nonce"),
  ).rejects.toBeInstanceOf(Error);
  const first = await gateway.exchange(
    "synthetic-code",
    "synthetic-verifier",
    "synthetic-nonce",
  );
  await expect(
    gateway.access(first.cache, "44444444-4444-4444-8444-444444444444"),
  ).rejects.toMatchObject({ code: "microsoft_reauthorization_required" });
});
it.each(["invalid_grant", "interaction_required", "consent_required"])(
  "MSAL refresh errors map to safe reauthorization: %s",
  (code) => {
    const error = microsoftError({
      errorCode: code,
      errorMessage: "synthetic private body token",
    });
    expect(error.code).toBe("microsoft_reauthorization_required");
    expect(error.message).not.toContain("private");
  },
);
