export interface MicrosoftIdentity {
  tenantId: string;
  accountId: string;
  nonce?: string;
  issuer: string;
  audience: string;
  expiresAt: number;
}
export interface MicrosoftTokenResult {
  cache: string;
  accessToken: string;
  identity: MicrosoftIdentity;
  scopes: string[];
  refreshCapable: boolean;
}
export interface MicrosoftGateway {
  authorizationUrl(parameters: Record<string, string>): Promise<string>;
  exchange(
    code: string,
    verifier: string,
    nonce: string,
  ): Promise<MicrosoftTokenResult>;
  access(cache: string, accountId: string): Promise<MicrosoftTokenResult>;
}
import {
  ConfidentialClientApplication,
  type AuthenticationResult,
} from "@azure/msal-node";
import { z } from "zod";
import { AppError } from "@hub/contracts";
import type { Config } from "../../config/env.js";
import { microsoftNetwork } from "./network.js";
export const MICROSOFT_MAIL_SCOPE = "https://graph.microsoft.com/Mail.Read";
export function hasMailRead(scopes: string[]): boolean {
  return scopes.some(
    (s) =>
      s.toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//, "") ===
      "mail.read",
  );
}
export function microsoftError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const e =
    typeof error === "object" && error !== null
      ? (error as {
          errorCode?: unknown;
          subError?: unknown;
          errorCodes?: unknown;
        })
      : {};
  if (
    [
      "invalid_grant",
      "interaction_required",
      "consent_required",
      "login_required",
      "no_tokens_found",
      "no_account_in_silent_request",
    ].includes(String(e.errorCode)) ||
    ["consent_required", "basic_action", "additional_action"].includes(
      String(e.subError),
    )
  )
    return new AppError("microsoft_reauthorization_required", 403);
  if (
    ["unauthorized_client", "access_denied", "invalid_client"].includes(
      String(e.errorCode),
    )
  )
    return new AppError("microsoft_connection_blocked", 403);
  return new AppError("microsoft_unavailable", 503);
}
const claims = z.object({
  tid: z.uuid(),
  oid: z.uuid(),
  nonce: z.string().optional(),
  iss: z.url(),
  aud: z.string(),
  exp: z.number().int(),
});
export function microsoftGateway(config: Config): MicrosoftGateway {
  const clientId = config.MICROSOFT_CLIENT_ID!,
    tenantId = config.MICROSOFT_TENANT_ID!;
  const client = () =>
    new ConfidentialClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        clientSecret: config.MICROSOFT_CLIENT_SECRET!,
      },
      system: {
        networkClient: microsoftNetwork(config.PROVIDER_TIMEOUT_MS),
        loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
      },
    });
  function result(
    app: ConfidentialClientApplication,
    r: AuthenticationResult | null,
  ): MicrosoftTokenResult {
    if (
      !r?.account ||
      !r.accessToken ||
      !r.expiresOn ||
      r.expiresOn.valueOf() <= Date.now()
    )
      throw new AppError("microsoft_reauthorization_required", 403);
    const c = claims.safeParse(r.idTokenClaims);
    if (
      !c.success ||
      r.account.localAccountId !== c.data.oid ||
      r.account.tenantId.toLowerCase() !== c.data.tid.toLowerCase()
    )
      throw new AppError("invalid_identity", 401);
    const cache = app.getTokenCache().serialize();
    const parsed = JSON.parse(cache) as {
      RefreshToken?: Record<
        string,
        { client_id?: string; home_account_id?: string; secret?: string }
      >;
    };
    const refreshCapable = Object.values(parsed.RefreshToken || {}).some(
      (v) =>
        v.client_id === clientId &&
        v.home_account_id === r.account!.homeAccountId &&
        !!v.secret,
    );
    return {
      cache,
      accessToken: r.accessToken,
      scopes: r.scopes,
      refreshCapable,
      identity: {
        tenantId: c.data.tid,
        accountId: c.data.oid,
        nonce: c.data.nonce,
        issuer: c.data.iss,
        audience: c.data.aud,
        expiresAt: c.data.exp * 1000,
      },
    };
  }
  return {
    authorizationUrl: async (p) => {
      try {
        return await client().getAuthCodeUrl({
          scopes: [MICROSOFT_MAIL_SCOPE],
          redirectUri: config.MICROSOFT_REDIRECT_URI!,
          state: p.state,
          nonce: p.nonce,
          codeChallenge: p.code_challenge,
          codeChallengeMethod: "S256",
          prompt: "select_account",
          responseMode: "query",
        });
      } catch (e) {
        throw microsoftError(e);
      }
    },
    exchange: async (code, verifier, nonce) => {
      const app = client();
      try {
        return result(
          app,
          await app.acquireTokenByCode({
            scopes: [MICROSOFT_MAIL_SCOPE],
            redirectUri: config.MICROSOFT_REDIRECT_URI!,
            code,
            codeVerifier: verifier,
            nonce,
          }),
        );
      } catch (e) {
        throw microsoftError(e);
      }
    },
    access: async (cache, accountId) => {
      const app = client();
      try {
        app.getTokenCache().deserialize(cache);
        const accounts = await app.getTokenCache().getAllAccounts();
        const account = accounts.find(
          (a) =>
            a.localAccountId === accountId &&
            a.tenantId.toLowerCase() === tenantId.toLowerCase(),
        );
        if (!account)
          throw new AppError("microsoft_reauthorization_required", 403);
        return result(
          app,
          await app.acquireTokenSilent({
            account,
            scopes: [MICROSOFT_MAIL_SCOPE],
          }),
        );
      } catch (e) {
        throw microsoftError(e);
      }
    },
  };
}
