import type { Express } from "express";
import { z } from "zod";
import { requireActor } from "../middleware/auth.js";
import {
  readCookie,
  setSessionCookie,
} from "../infrastructure/sessions/cookies.js";
import { db } from "../infrastructure/persistence/db.js";
import { MicrosoftOAuthService } from "../infrastructure/microsoft/oauth.js";
import type { Config } from "../config/env.js";
import { AppError } from "@hub/contracts";
export function microsoftRoutes(
  app: Express,
  config: Config,
  oauth: MicrosoftOAuthService,
): void {
  app.get("/api/connections/microsoft", requireActor, async (_req, res) => {
    const auth = await db.microsoftAuthorization.findUnique({
      where: { userId: res.locals.actor.userId },
      select: { status: true },
    });
    res.json({
      configured: oauth.configured(),
      status: auth?.status || "disconnected",
    });
  });
  app.post(
    "/api/connections/microsoft/start",
    requireActor,
    async (req, res) => {
      res.json(await oauth.startAuthorization(readCookie(req)));
    },
  );
  app.get("/auth/microsoft/callback", async (req, res) => {
    try {
      const callback = z
        .object({
          state: z.string().min(1).max(128),
          code: z.string().min(1).max(8192).optional(),
          error: z.string().max(128).optional(),
        })
        .parse(req.query);
      const result = await oauth.completeAuthorization(
        callback,
        readCookie(req),
      );
      setSessionCookie(res, result.token, config.NODE_ENV === "production");
      res.redirect("/");
    } catch (error) {
      // This is a browser navigation, not an API response. Return only a fixed
      // outcome; provider diagnostics, callback values and credentials stay out.
      const code = error instanceof AppError ? error.code : "";
      const outcome =
        code === "microsoft_consent_denied"
          ? "denied"
          : code === "microsoft_connection_blocked"
            ? "blocked"
            : code === "microsoft_reauthorization_required"
              ? "reconnect"
              : "failed";
      res.redirect("/?microsoft=" + outcome);
    }
  });
  app.delete("/api/connections/microsoft", requireActor, async (_req, res) => {
    await oauth.disconnect(res.locals.actor);
    res.json({ configured: oauth.configured(), status: "disconnected" });
  });
}
