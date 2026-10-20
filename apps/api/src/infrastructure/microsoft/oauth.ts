import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { AppError, type Actor } from "@hub/contracts";
import type { Config } from "../../config/env.js";
import { db } from "../persistence/db.js";
import {
  readSession,
  hashToken,
  createSession,
  destroySession,
} from "../sessions/store.js";
import { encryptToken, decryptToken } from "../google/tokenVault.js";
import {
  microsoftGateway,
  microsoftError,
  hasMailRead,
  type MicrosoftGateway,
  type MicrosoftTokenResult,
} from "./gateway.js";
export class MicrosoftOAuthService {
  constructor(
    private config: Config,
    private gateway?: MicrosoftGateway,
  ) {}
  configured(): boolean {
    return !!(
      this.config.MICROSOFT_CLIENT_ID &&
      this.config.MICROSOFT_TENANT_ID &&
      this.config.MICROSOFT_CLIENT_SECRET &&
      this.config.MICROSOFT_REDIRECT_URI
    );
  }
  private provider(): MicrosoftGateway {
    if (!this.configured()) throw new AppError("microsoft_not_configured", 503);
    return (this.gateway ??= microsoftGateway(this.config));
  }
  private validate(result: MicrosoftTokenResult, nonce?: string): void {
    const i = result.identity;
    if (
      !z.uuid().safeParse(i.accountId).success ||
      i.tenantId.toLowerCase() !==
        this.config.MICROSOFT_TENANT_ID!.toLowerCase() ||
      i.audience !== this.config.MICROSOFT_CLIENT_ID ||
      i.issuer.toLowerCase() !==
        `https://login.microsoftonline.com/${this.config.MICROSOFT_TENANT_ID}/v2.0`.toLowerCase() ||
      (nonce !== undefined &&
        (i.nonce !== nonce ||
          !Number.isFinite(i.expiresAt) ||
          i.expiresAt <= Date.now()))
    )
      throw new AppError("invalid_identity", 401);
    if (!hasMailRead(result.scopes))
      throw new AppError("microsoft_scope_not_granted", 403);
    if (!result.refreshCapable || !result.cache || !result.accessToken)
      throw new AppError("microsoft_offline_access_required", 403);
  }
  async startAuthorization(token: string): Promise<{ url: string }> {
    const session = await readSession(token);
    if (!session?.userId) throw new AppError("authentication_required", 401);
    const provider = this.provider();
    const auth = await db.microsoftAuthorization.upsert({
      where: { userId: session.userId },
      create: {
        userId: session.userId,
        tenantId: this.config.MICROSOFT_TENANT_ID!,
        accountId: null,
        scopes: [],
        status: "disconnected",
      },
      update: {},
    });
    if (
      auth.tenantId.toLowerCase() !==
      this.config.MICROSOFT_TENANT_ID!.toLowerCase()
    )
      throw new AppError("account_mismatch", 409);
    const state = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url"),
      verifier = randomBytes(32).toString("base64url");
    await db.oAuthState.create({
      data: {
        stateHash: hashToken(state),
        sessionId: session.id,
        intent: "microsoft",
        nonce,
        verifier,
        authorizationRevision: auth.revision,
        expiresAt: new Date(Date.now() + 10 * 60000),
      },
    });
    return {
      url: await provider.authorizationUrl({
        state,
        nonce,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
      }),
    };
  }
  async completeAuthorization(
    callback: { state: string; code?: string; error?: string },
    token: string,
  ): Promise<{ token: string }> {
    const session = await readSession(token);
    if (!session?.userId) throw new AppError("invalid_state", 401);
    const provider = this.provider();
    const state = await db.$transaction(async (tx) => {
      const s = await tx.oAuthState.findUnique({
        where: { stateHash: hashToken(callback.state) },
      });
      if (
        !s ||
        s.intent !== "microsoft" ||
        s.sessionId !== session.id ||
        s.expiresAt <= new Date()
      )
        throw new AppError("invalid_state", 401);
      if (
        (await tx.oAuthState.deleteMany({ where: { stateHash: s.stateHash } }))
          .count !== 1
      )
        throw new AppError("invalid_state", 401);
      return s;
    });
    if (callback.error)
      throw new AppError(
        callback.error === "access_denied"
          ? "microsoft_consent_denied"
          : [
                "unauthorized_client",
                "invalid_client",
                "interaction_required",
              ].includes(callback.error)
            ? "microsoft_connection_blocked"
            : "microsoft_unavailable",
        callback.error === "access_denied" ||
          callback.error === "unauthorized_client"
          ? 403
          : 503,
      );
    if (!callback.code) throw new AppError("invalid_input", 422);
    let result: MicrosoftTokenResult;
    try {
      result = await provider.exchange(
        callback.code,
        state.verifier,
        state.nonce,
      );
      this.validate(result, state.nonce);
    } catch (e) {
      throw microsoftError(e);
    }
    await db.$transaction(async (tx) => {
      const auth = await tx.microsoftAuthorization.findUnique({
        where: { userId: session.userId! },
      });
      if (!auth || auth.revision !== state.authorizationRevision)
        throw new AppError("invalid_state", 401);
      if (auth.accountId && auth.accountId !== result.identity.accountId)
        throw new AppError("account_mismatch", 409);
      const updated = await tx.microsoftAuthorization.updateMany({
        where: { id: auth.id, revision: auth.revision },
        data: {
          accountId: result.identity.accountId,
          tokenCache: encryptToken(
            result.cache,
            this.config.TOKEN_ENCRYPTION_KEY,
          ),
          scopes: result.scopes,
          status: "connected",
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new AppError("invalid_state", 401);
      await tx.sourceConnection.upsert({
        where: {
          userId_provider: { userId: session.userId!, provider: "outlook" },
        },
        create: {
          userId: session.userId!,
          provider: "outlook",
          microsoftAuthorizationId: auth.id,
          externalAccountId: auth.tenantId + ":" + result.identity.accountId,
        },
        update: { microsoftAuthorizationId: auth.id, status: "connected" },
      });
      await tx.historyEntry.create({
        data: {
          userId: session.userId!,
          action: "connection_authorized",
          reason: "outlook",
          actor: "user",
        },
      });
    });
    const next = await createSession(session.userId);
    await destroySession(token);
    return { token: next.token };
  }
  async accessToken(actor: Actor): Promise<{
    accessToken: string;
    authorizationId: string;
    revision: number;
  }> {
    const provider = this.provider();
    const auth = await db.microsoftAuthorization.findUnique({
      where: { userId: actor.userId },
    });
    if (!auth?.tokenCache || !auth.accountId || auth.status !== "connected")
      throw new AppError("microsoft_reauthorization_required", 403);
    let result: MicrosoftTokenResult, priorCache: string;
    try {
      try {
        priorCache = decryptToken(
          auth.tokenCache,
          this.config.TOKEN_ENCRYPTION_KEY,
        );
      } catch {
        throw new AppError("microsoft_reauthorization_required", 403);
      }
      result = await provider.access(priorCache, auth.accountId);
      try {
        this.validate(result);
        if (
          result.identity.accountId !== auth.accountId ||
          result.identity.tenantId.toLowerCase() !== auth.tenantId.toLowerCase()
        )
          throw new AppError("invalid_identity", 401);
      } catch {
        throw new AppError("microsoft_reauthorization_required", 403);
      }
    } catch (e) {
      const error = microsoftError(e);
      if (
        [
          "microsoft_reauthorization_required",
          "microsoft_connection_blocked",
        ].includes(error.code)
      )
        await this.invalidate(
          actor,
          auth.id,
          auth.revision,
          error.code === "microsoft_connection_blocked"
            ? "blocked"
            : "reauthorization_required",
        );
      throw error;
    }
    const changed = result.cache !== priorCache;
    const updated = await db.microsoftAuthorization.updateMany({
      where: { id: auth.id, revision: auth.revision, status: "connected" },
      data: changed
        ? {
            tokenCache: encryptToken(
              result.cache,
              this.config.TOKEN_ENCRYPTION_KEY,
            ),
            revision: { increment: 1 },
          }
        : { status: "connected" },
    });
    if (updated.count !== 1)
      throw new AppError("microsoft_reauthorization_required", 403);
    return {
      accessToken: result.accessToken,
      authorizationId: auth.id,
      revision: auth.revision + (changed ? 1 : 0),
    };
  }
  async invalidate(
    actor: Actor,
    id: string,
    revision: number,
    status: "blocked" | "reauthorization_required",
  ): Promise<void> {
    await db.$transaction(async (tx) => {
      const updated = await tx.microsoftAuthorization.updateMany({
        where: { id, userId: actor.userId, revision, status: "connected" },
        data: { tokenCache: null, status, revision: { increment: 1 } },
      });
      if (updated.count)
        await tx.sourceConnection.updateMany({
          where: {
            userId: actor.userId,
            provider: "outlook",
            microsoftAuthorizationId: id,
          },
          data: { status },
        });
    });
  }
  async disconnect(actor: Actor): Promise<void> {
    await db.$transaction(async (tx) => {
      await tx.microsoftAuthorization.updateMany({
        where: { userId: actor.userId },
        data: {
          tokenCache: null,
          scopes: [],
          status: "disconnected",
          revision: { increment: 1 },
        },
      });
      await tx.sourceConnection.updateMany({
        where: { userId: actor.userId, provider: "outlook" },
        data: { status: "disconnected" },
      });
      await tx.oAuthState.deleteMany({
        where: { intent: "microsoft", session: { userId: actor.userId } },
      });
      await tx.historyEntry.create({
        data: {
          userId: actor.userId,
          action: "microsoft_disconnected",
          actor: "user",
        },
      });
    });
  }
}
