import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { randomBytes } from "node:crypto";
import { AppError } from "@hub/contracts";
import { db } from "../persistence/db.js";
import {
  hashToken,
  readSession,
  createSession,
  destroySession,
} from "../sessions/store.js";
import { encryptToken } from "./tokenVault.js";
import type { Config } from "../../config/env.js";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.owned";
export type Intent = "login" | "gmail" | "calendar";
export interface OAuthGateway {
  authorizationUrl(parameters: Record<string, string>): string;
  exchange(
    code: string,
    verifier: string,
  ): Promise<{ idToken: string; refreshToken?: string; scope: string }>;
  verify(
    idToken: string,
  ): Promise<{ sub: string; email: string; nonce?: string }>;
}
export function googleOAuthGateway(config: Config): OAuthGateway {
  const client = new OAuth2Client({
    clientId: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    redirectUri: config.GOOGLE_REDIRECT_URI,
    transporterOptions: { timeout: config.PROVIDER_TIMEOUT_MS },
  });
  return {
    authorizationUrl: (p) =>
      client.generateAuthUrl({
        ...p,
        scope: p.scope.split(" "),
        code_challenge_method: CodeChallengeMethod.S256,
        include_granted_scopes: true,
        access_type: "offline",
      }),
    exchange: async (code, verifier) => {
      const { tokens } = await client.getToken({
        code,
        codeVerifier: verifier,
        redirect_uri: config.GOOGLE_REDIRECT_URI,
      });
      if (!tokens.id_token) throw new AppError("invalid_identity", 401);
      return {
        idToken: tokens.id_token,
        refreshToken: tokens.refresh_token || undefined,
        scope: tokens.scope || "",
      };
    },
    verify: async (token) => {
      const ticket = await client.verifyIdToken({
        idToken: token,
        audience: config.GOOGLE_CLIENT_ID,
      });
      const p = ticket.getPayload();
      if (!p?.sub || !p.email || !p.email_verified)
        throw new AppError("invalid_identity", 401);
      return {
        sub: p.sub,
        email: p.email,
        nonce: (p as typeof p & { nonce?: string }).nonce,
      };
    },
  };
}
export class OAuthService {
  constructor(
    private config: Config,
    private gateway: OAuthGateway = googleOAuthGateway(config),
  ) {}
  async startAuthorization(
    intent: Intent,
    token: string,
  ): Promise<{ url: string }> {
    const session = await readSession(token);
    if (!session || (intent !== "login" && !session.userId))
      throw new AppError("authentication_required", 401);
    const state = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url"),
      verifier = randomBytes(32).toString("base64url");
    await db.oAuthState.create({
      data: {
        stateHash: hashToken(state),
        sessionId: session.id,
        intent,
        nonce,
        verifier,
        expiresAt: new Date(Date.now() + 10 * 60000),
      },
    });
    return {
      url: this.gateway.authorizationUrl({
        state,
        nonce,
        code_challenge: hashTokenBase64(verifier),
        scope: [
          "openid",
          "email",
          "profile",
          ...(intent === "gmail"
            ? [GMAIL_SCOPE]
            : intent === "calendar"
              ? [CALENDAR_SCOPE]
              : []),
        ].join(" "),
        ...(intent !== "login" ? { prompt: "consent" } : {}),
      }),
    };
  }
  async completeAuthorization(
    callback: { state: string; code: string },
    token: string,
  ): Promise<{ token: string }> {
    const session = await readSession(token);
    if (!session) throw new AppError("invalid_state", 401);
    const state = await db.$transaction(async (tx) => {
      const s = await tx.oAuthState.findUnique({
        where: { stateHash: hashToken(callback.state) },
      });
      if (
        !s ||
        !["login", "gmail", "calendar"].includes(s.intent) ||
        s.sessionId !== session.id ||
        s.expiresAt <= new Date()
      )
        throw new AppError("invalid_state", 401);
      const consumed = await tx.oAuthState.deleteMany({
        where: { stateHash: s.stateHash },
      });
      if (consumed.count !== 1) throw new AppError("invalid_state", 401);
      return s;
    });
    let tokens: Awaited<ReturnType<OAuthGateway["exchange"]>>,
      identity: Awaited<ReturnType<OAuthGateway["verify"]>>;
    try {
      tokens = await this.gateway.exchange(callback.code, state.verifier);
      identity = await this.gateway.verify(tokens.idToken);
    } catch {
      throw new AppError("invalid_identity", 401);
    }
    if (identity.nonce !== state.nonce)
      throw new AppError("invalid_identity", 401);
    if (session.user && session.user.googleSubject !== identity.sub)
      throw new AppError("account_mismatch", 409);
    const scopes = tokens.scope.split(" ").filter(Boolean);
    const required =
      state.intent === "gmail"
        ? GMAIL_SCOPE
        : state.intent === "calendar"
          ? CALENDAR_SCOPE
          : null;
    if (required && !scopes.includes(required))
      throw new AppError("scope_not_granted", 403);
    const user = await db.user.upsert({
      where: { googleSubject: identity.sub },
      create: { googleSubject: identity.sub, email: identity.email },
      update: { email: identity.email },
    });
    if (required) {
      await db.$transaction(async (tx) => {
        const prior = await tx.googleAuthorization.findUnique({
          where: { userId: user.id },
        });
        const refresh = tokens.refreshToken
          ? encryptToken(tokens.refreshToken, this.config.TOKEN_ENCRYPTION_KEY)
          : prior?.refreshToken;
        if (!refresh) throw new AppError("offline_access_required", 403);
        const auth = await tx.googleAuthorization.upsert({
          where: { userId: user.id },
          create: {
            userId: user.id,
            subject: identity.sub,
            refreshToken: refresh,
            scopes,
            status: "connected",
          },
          update: { refreshToken: refresh, scopes, status: "connected" },
        });
        if (state.intent === "gmail")
          await tx.sourceConnection.upsert({
            where: { userId_provider: { userId: user.id, provider: "gmail" } },
            create: {
              userId: user.id,
              authorizationId: auth.id,
              externalAccountId: identity.sub,
            },
            update: { authorizationId: auth.id, status: "connected" },
          });
        await tx.historyEntry.create({
          data: {
            userId: user.id,
            action: "connection_authorized",
            reason: state.intent,
            actor: "user",
          },
        });
      });
    }
    const next = await createSession(user.id);
    await destroySession(token);
    return { token: next.token };
  }
}
import { createHash } from "node:crypto";
const hashTokenBase64 = (token: string) =>
  createHash("sha256").update(token).digest("base64url");
