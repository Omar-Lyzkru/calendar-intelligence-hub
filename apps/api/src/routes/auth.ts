import type { Express } from "express";
import { z } from "zod";
import { timezone, AppError } from "@hub/contracts";
import {
  createSession,
  destroySession,
} from "../infrastructure/sessions/store.js";
import {
  readCookie,
  setSessionCookie,
} from "../infrastructure/sessions/cookies.js";
import { db } from "../infrastructure/persistence/db.js";
import { OAuth2Client } from "google-auth-library";
import { decryptToken } from "../infrastructure/google/tokenVault.js";
import { OAuthService } from "../infrastructure/google/oauth.js";
import { requireActor } from "../middleware/auth.js";
import type { Config } from "../config/env.js";
export function authRoutes(app: Express, config: Config, oauth: OAuthService) {
  app.get("/api/me", async (_req, res) => {
    if (!res.locals.session) {
      const s = await createSession();
      setSessionCookie(res, s.token, config.NODE_ENV === "production");
      res.locals.session = s;
    }
    const s = res.locals.session;
    const user = s.userId
      ? await db.user.findUnique({ where: { id: s.userId } })
      : null;
    res.json({
      user: user
        ? { id: user.id, email: user.email, timezone: user.timezone }
        : null,
      csrf: s.csrf,
    });
  });
  app.patch("/api/me", requireActor, async (req, res) => {
    const input = z.object({ timezone }).strict().parse(req.body);
    await db.user.update({
      where: { id: res.locals.actor.userId },
      data: input,
    });
    res.json(input);
  });
  app.get("/auth/google/start", async (req, res) => {
    const intent = z
      .enum(["login", "gmail", "calendar"])
      .parse(req.query.intent || "login");
    if (!res.locals.session) {
      const s = await createSession();
      setSessionCookie(res, s.token, config.NODE_ENV === "production");
      res.locals.session = s;
      req.headers.cookie = "hub_session=" + s.token;
    }
    const r = await oauth.startAuthorization(intent, readCookie(req));
    res.redirect(r.url);
  });
  app.get("/auth/google/callback", async (req, res) => {
    if (req.query.error) throw new AppError("consent_denied", 403);
    const input = z
      .object({ state: z.string().min(1), code: z.string().min(1) })
      .parse(req.query);
    const result = await oauth.completeAuthorization(input, readCookie(req));
    setSessionCookie(res, result.token, config.NODE_ENV === "production");
    res.redirect("/");
  });
  app.post("/api/logout", async (req, res) => {
    await destroySession(readCookie(req));
    res.clearCookie("hub_session", { path: "/" });
    res.sendStatus(204);
  });
  app.get("/api/connections", requireActor, async (_req, res) => {
    const a = await db.googleAuthorization.findUnique({
      where: { userId: res.locals.actor.userId },
    });
    res.json({ status: a?.status || "disconnected", scopes: a?.scopes || [] });
  });
  app.delete("/api/connections/google", requireActor, async (_req, res) => {
    const userId = res.locals.actor.userId;
    const auth = await db.googleAuthorization.findUnique({ where: { userId } });
    let remoteRevocationFailed = false;
    if (auth?.refreshToken) {
      try {
        await new OAuth2Client({
          transporterOptions: {
            timeout: config.PROVIDER_TIMEOUT_MS,
            retry: false,
          },
        }).revokeToken(
          decryptToken(auth.refreshToken, config.TOKEN_ENCRYPTION_KEY),
        );
      } catch {
        remoteRevocationFailed = true;
      }
    }
    await db.$transaction([
      db.googleAuthorization.updateMany({
        where: { userId },
        data: { refreshToken: null, scopes: [], status: "disconnected" },
      }),
      db.sourceConnection.updateMany({
        where: { userId, provider: "gmail" },
        data: { status: "disconnected" },
      }),
      db.historyEntry.create({
        data: { userId, action: "connection_disconnected", actor: "user" },
      }),
    ]);
    res.json({ status: "disconnected", remoteRevocationFailed });
  });
}
