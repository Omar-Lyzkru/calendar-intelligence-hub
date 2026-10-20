import type { AutomationScheduler } from "./application/automation/scheduler.js";
import { automationRoutes } from "./routes/automation.js";
import { discordRoutes, type DiscordControl } from "./routes/discord.js";
import type { DiscordRest } from "./infrastructure/discord/rest.js";
import express from "express";
import { resolve } from "node:path";
import type { Config } from "./config/env.js";
import { OAuthService } from "./infrastructure/google/oauth.js";
import { sessionMiddleware } from "./middleware/auth.js";
import { csrfProtection } from "./infrastructure/sessions/csrf.js";
import { authRoutes } from "./routes/auth.js";
import {
  googleGmail,
  type GmailGateway,
} from "./infrastructure/google/gmail.js";
import { importRoutes } from "./routes/imports.js";
import { reviewRoutes } from "./routes/reviews.js";
import {
  googleCalendar,
  type CalendarGateway,
} from "./infrastructure/google/calendar.js";
import { errors } from "./middleware/errors.js";
import { MicrosoftOAuthService } from "./infrastructure/microsoft/oauth.js";
import { microsoftRoutes } from "./routes/microsoft.js";
import { outlookMail } from "./infrastructure/microsoft/outlook.js";
import type { MessageSourceAdapter } from "@hub/contracts";
export interface AppDependencies {
  config: Config;
  automationScheduler?: Pick<AutomationScheduler, "tick">;
  oauth?: OAuthService;
  microsoftOAuth?: MicrosoftOAuthService;
  outlook?: MessageSourceAdapter;
  gmail?: GmailGateway;
  calendar?: CalendarGateway;
  webRoot?: string;
  discord?: DiscordControl | null;
  discordRest?: Pick<DiscordRest, "checkAccess">;
}
export function createApp(deps?: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    next();
  });
  app.use(express.json({ limit: "300kb" }));
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  if (deps) {
    app.use(sessionMiddleware);
    app.use(csrfProtection(deps.config.APP_ORIGIN));
    authRoutes(app, deps.config, deps.oauth || new OAuthService(deps.config));
    const microsoft =
      deps.microsoftOAuth || new MicrosoftOAuthService(deps.config);
    microsoftRoutes(app, deps.config, microsoft);
    importRoutes(
      app,
      deps.gmail || googleGmail(deps.config),
      deps.outlook || outlookMail(deps.config, microsoft),
    );
    discordRoutes(app, deps.config, deps.discord || null, deps.discordRest);
    reviewRoutes(app, deps.calendar || googleCalendar(deps.config));
    automationRoutes(
      app,
      deps.calendar || googleCalendar(deps.config),
      {
        allowWrites: deps.config.AUTOMATION_LIVE_WRITES_ENABLED === true,
      },
      deps.automationScheduler,
    );
  }
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: { code: "not_found" } }),
  );
  if (deps?.webRoot || deps?.config.NODE_ENV === "production") {
    const webRoot = resolve(deps.webRoot || "dist/web");
    app.use(express.static(webRoot));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(resolve(webRoot, "index.html")),
    );
  }
  app.use(errors);
  return app;
}
