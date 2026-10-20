import { AutomationScheduler } from "../../apps/api/src/application/automation/scheduler.js";
import {
  getPolicy,
  savePolicy,
} from "../../apps/api/src/application/automation/policyStore.js";
import { importMessages } from "../../apps/api/src/application/importMessages.js";
import type { AppDependencies } from "../../apps/api/src/app.js";
import { DiscordRuntime } from "../../apps/api/src/infrastructure/discord/runtime.js";
import {
  ingestDiscord,
  recordDiscordChange,
} from "../../apps/api/src/application/discordIngestion.js";
// Synthetic provider harness only. This file is never imported by production.
import { createApp } from "../../apps/api/src/app.js";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import {
  createSession,
  hashToken,
} from "../../apps/api/src/infrastructure/sessions/store.js";
import { setSessionCookie } from "../../apps/api/src/infrastructure/sessions/cookies.js";
import { AppError, type CalendarReceipt } from "@hub/contracts";
import { MicrosoftOAuthService } from "../../apps/api/src/infrastructure/microsoft/oauth.js";
import { normalizeOutlook } from "../../apps/api/src/infrastructure/microsoft/normalize.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("E2E requires separate TEST_DATABASE_URL ending _test");
const config = {
  NODE_ENV: "test" as const,
  AUTOMATION_LIVE_WRITES_ENABLED: true,
  PORT: 4173,
  APP_ORIGIN: "http://127.0.0.1:4173",
  DATABASE_URL: url,
  GOOGLE_CLIENT_ID: "synthetic",
  GOOGLE_CLIENT_SECRET: "synthetic",
  GOOGLE_REDIRECT_URI: "http://127.0.0.1:4173/auth/google/callback",
  TOKEN_ENCRYPTION_KEY: "1".repeat(64),
  PROVIDER_TIMEOUT_MS: 15000,
  DISCORD_BOT_TOKEN: "synthetic-token-not-real",
  DISCORD_GUILD_ID: String(810000000000000000n + BigInt(Date.now())),
  DISCORD_CHANNEL_IDS: "800000000000000002",
  MICROSOFT_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
  MICROSOFT_TENANT_ID: "22222222-2222-4222-8222-222222222222",
  MICROSOFT_CLIENT_SECRET: "synthetic-only",
  MICROSOFT_REDIRECT_URI: "http://127.0.0.1:4173/auth/microsoft/callback",
};
const outlookMessage = {
  id: "AAMkSynthetic+Case=",
  subject: "CodeRED Orion Outlook",
  receivedDateTime: "2026-10-01T12:00:00Z",
  body: {
    contentType: "html",
    content:
      "<p>Hackathon October 10, 2026 at 10:00 AM to 11:00 AM Central Time</p>",
  },
};
const microsoftPolicy = new Map<
  string,
  "access_denied" | "unauthorized_client"
>();
function microsoftResult(nonce?: string) {
  return {
    cache: "synthetic-cache-with-refresh",
    accessToken: "synthetic-access",
    scopes: ["https://graph.microsoft.com/Mail.Read"],
    refreshCapable: true,
    identity: {
      tenantId: config.MICROSOFT_TENANT_ID,
      accountId: "33333333-3333-4333-8333-333333333333",
      nonce,
      issuer: `https://login.microsoftonline.com/${config.MICROSOFT_TENANT_ID}/v2.0`,
      audience: config.MICROSOFT_CLIENT_ID,
      expiresAt: Date.now() + 3600000,
    },
  };
}
const microsoftOAuth = new MicrosoftOAuthService(config, {
  authorizationUrl: async (p) => {
    // Local redirect only; no Microsoft service is contacted by this harness.
    const state = await db.oAuthState.findUnique({
      where: { stateHash: hashToken(p.state) },
      include: { session: true },
    });
    const denied =
      state?.session.userId && microsoftPolicy.get(state.session.userId);
    if (denied)
      return `${config.MICROSOFT_REDIRECT_URI}?state=${encodeURIComponent(p.state)}&error=${denied}&error_description=synthetic-private-diagnostic`;
    return `${config.MICROSOFT_REDIRECT_URI}?state=${encodeURIComponent(p.state)}&code=${encodeURIComponent(p.nonce)}`;
  },
  exchange: async (code, _verifier, nonce) => {
    if (code !== nonce) throw new AppError("invalid_identity", 401);
    return microsoftResult(nonce);
  },
  access: async () => microsoftResult(),
});
const messages = [
  {
    id: "auto-safe",
    subject: "Automatic Exam",
    sender: "fixture@example.test",
    snippet: "Exam October 22, 2026 at 2:00 PM to 3:00 PM America/Chicago",
  },
  {
    id: "auto-second",
    subject: "Automatic Second Exam",
    sender: "fixture@example.test",
    snippet: "Exam October 24, 2026 at 2:00 PM to 3:00 PM America/Chicago",
  },
  {
    id: "auto-question",
    subject: "Question Exam",
    sender: "fixture@example.test",
    snippet: "Exam October 23, 2026",
  },
  {
    id: "auto-problem",
    subject: "Problem Exam",
    sender: "fixture@example.test",
    snippet:
      "Exam October 12, 2026 at 2:00 PM to 3:00 PM America/Chicago PRIVATE_AUTOMATION_SENTINEL",
  },
  {
    id: "auto-newsletter",
    subject: "Department Newsletter",
    sender: "fixture@example.test",
    snippet: "Department newsletter with general information",
  },
  {
    id: "conflict-meeting",
    subject: "Synthetic Conflict Meeting",
    sender: "fixture@example.test",
    snippet: "Workshop October 10, 2026 at 10:00 AM to 11:00 AM Central Time",
  },
  {
    id: "conflict-day",
    subject: "Synthetic All-day Conflict",
    sender: "fixture@example.test",
    snippet: "Workshop October 10, 2026.",
  },
  {
    id: "conflict-partial",
    subject: "Synthetic Conflict Lookup Partial",
    sender: "fixture@example.test",
    snippet: "Workshop October 14, 2026 at 10:00 AM to 11:00 AM Central Time",
  },
  {
    id: "duplicate",
    subject: "CodeRED Orion",
    sender: "fixture@example.test",
    snippet: "Hackathon October 10, 2026 at 10:00 AM–11:00 AM Central Time",
  },
  {
    id: "lookup-unavailable",
    subject: "Synthetic Lookup Unavailable",
    sender: "fixture@example.test",
    snippet: "Workshop October 12, 2026 at 10:00 AM–11:00 AM Central Time",
  },
  {
    id: "untitled",
    subject: "",
    sender: "fixture@example.test",
    snippet: "Workshop October 20, 2026",
  },
  {
    id: "bad-payload",
    subject: "Synthetic Malformed Message",
    sender: "fixture@example.test",
    snippet: "Synthetic payload failure",
  },
  {
    id: "date-only",
    subject: "Synthetic Date-only Workshop",
    sender: "fixture@example.test",
    snippet: "Workshop December 31, 2026 through January 2, 2027",
  },
  {
    id: "partial-zone",
    subject: "Synthetic Partial Meeting",
    sender: "fixture@example.test",
    snippet: "Meeting Tuesday, October 20 at 2:30 PM CST",
  },
  {
    id: "fold",
    subject: "Synthetic Fallback Meeting",
    sender: "fixture@example.test",
    snippet: "Meeting November 1, 2026 at 1:30 AM–1:45 AM Central Time",
  },

  {
    id: "workshop",
    subject: "Synthetic Workshop",
    sender: "fixture@example.test",
    snippet: "Workshop October 8, 2026 at 2:00 PM",
  },
  {
    id: "ambiguous",
    subject: "Synthetic Exam",
    sender: "fixture@example.test",
    snippet: "Exam next Friday",
  },
  {
    id: "failure",
    subject: "Synthetic Career Event",
    sender: "fixture@example.test",
    snippet: "Career event October 9, 2026 at 2:00 PM",
  },
];
const receipts = new Map<string, CalendarReceipt>();
const failed = new Set<string>();
// Maintained-runtime boundary is replaced only in this synthetic browser harness.
const discordConfig = {
  token: config.DISCORD_BOT_TOKEN,
  guildId: config.DISCORD_GUILD_ID,
  channelIds: [config.DISCORD_CHANNEL_IDS],
};
let discordConnections = 0;
const discordPost = () => ({
  id: "800000000000000003",
  guild_id: discordConfig.guildId,
  channel_id: discordConfig.channelIds[0],
  type: 0,
  flags: 2,
  webhook_id: "800000000000000004",
  message_reference: {
    guild_id: "800000000000000005",
    channel_id: "800000000000000006",
    message_id: "800000000000000007",
  },
  timestamp: "2026-10-13T12:00:00Z",
  edited_timestamp: discordConnections > 1 ? "2026-10-13T13:00:00Z" : null,
  content:
    discordConnections > 1
      ? "Updated Workshop October 21, 2026 at 2:00 PM to 3:00 PM Central Time"
      : "Workshop October 20, 2026 at 2:00 PM to 3:00 PM Central Time",
  embeds: [],
});
const discordRest = {
  checkAccess: async () => {},
  getMessages: async () => [discordPost()],
  getMessage: async () => discordPost(),
};
const discord = new DiscordRuntime(
  discordConfig,
  discordRest,
  {
    start: async (deliver) => {
      discordConnections++;
      deliver({ kind: "ready" });
    },
    stop: async () => {},
  },
  {
    binding: async () => {
      const relay = await db.discordRelay.findUnique({
        where: { guildId: discordConfig.guildId },
      });
      return relay?.status === "connected"
        ? { generation: relay.generation }
        : null;
    },
    ingest: (p, g) => ingestDiscord(discordConfig, p, g),
    change: (e, g) => recordDiscordChange(discordConfig, e, g),
  },
);
const dependencies: AppDependencies = {
  config,
  discord,
  discordRest,
  webRoot: "dist/web",
  microsoftOAuth,
  outlook: {
    provider: "outlook",
    list: async (actor) => {
      const source = await db.sourceConnection.findFirst({
        where: {
          userId: actor.userId,
          provider: "outlook",
          status: "connected",
        },
      });
      if (!source)
        throw new AppError("microsoft_reauthorization_required", 403);
      return {
        messages: [
          {
            id: outlookMessage.id,
            subject: outlookMessage.subject,
            sender: "",
            snippet: "",
            receivedAt: outlookMessage.receivedDateTime,
          },
        ],
      };
    },
    get: async (_actor, id) => {
      if (id !== outlookMessage.id)
        throw new AppError("invalid_provider_response", 502);
      return outlookMessage;
    },
    normalize: normalizeOutlook,
  },
  gmail: {
    list: async () => ({ messages }),
    get: async (_a, id) => {
      const m = messages.find((m) => m.id === id);
      if (!m) throw Error("not found");
      if (id === "bad-payload")
        return { id, payload: { mimeType: "text/plain", body: { data: 42 } } };
      return {
        id,
        internalDate: String(Date.now()),
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "Subject", value: m.subject }],
          body: { data: Buffer.from(m.snippet).toString("base64url") },
        },
      };
    },
  },
  calendar: {
    list: async (actor, window) => {
      if (window.timeMin.startsWith("2026-10-11"))
        return {
          events: [],
          coverage: { status: "unavailable", reason: "provider_unavailable" },
        };
      if (window.timeMin.startsWith("2026-10-13"))
        return {
          events: [
            {
              key: "google:unknown",
              source: "google",
              title: "Different commitment",
              location: null,
              availability: "unknown",
              temporal: {
                kind: "all_day",
                startDate: "2026-10-14",
                endExclusive: "2026-10-15",
              },
            },
          ],
          coverage: { status: "checked" },
        };
      const temporal = {
        kind: "timed" as const,
        start: "2026-10-10T15:00:00.000Z",
        end: "2026-10-10T16:00:00.000Z",
        timezone: "America/Chicago",
      };
      const outlookConnected = await db.sourceConnection.findFirst({
        where: { userId: actor.userId, provider: "outlook" },
      });
      return {
        events:
          temporal.end > window.timeMin && temporal.start < window.timeMax
            ? [
                {
                  key: "google:manual",
                  source: "google",
                  availability: "busy",
                  title: "CodeRED Orion Hackathon",
                  location: null,
                  temporal,
                  providerEventId: "manual",
                  calendarId: "primary",
                  htmlLink: "https://calendar.google.com/calendar/u/0/r",
                },
                ...(outlookConnected
                  ? [
                      {
                        key: "google:other",
                        source: "google" as const,
                        availability: "busy" as const,
                        title: "Different commitment",
                        location: null,
                        temporal,
                      },
                    ]
                  : []),
              ]
            : [],
        coverage: { status: "checked" },
      };
    },
    get: async (_a, id) => receipts.get(id) || null,
    insert: async (_a, id, event, hash) => {
      const receipt = {
        providerEventId: id,
        calendarId: "primary",
        htmlLink: "https://calendar.google.com/calendar/u/0/r",
        payloadHash: hash,
      };
      receipts.set(id, receipt);
      if (event.title === "Synthetic Career Event" && !failed.has(id)) {
        failed.add(id);
        throw new AppError("provider_timeout", 503);
      }
      return receipt;
    },
  },
};
const automationScheduler = new AutomationScheduler({
  gmail: dependencies.gmail!,
  calendar: dependencies.calendar!,
  allowWrites: true,
});
const app = createApp({ ...dependencies, automationScheduler });
// Register harness routes before the production catch-all via a separate wrapper.
import express from "express";
const harness = express();
harness.get("/test/login", async (req, res) => {
  const user = await db.user.create({
    data: {
      googleSubject: crypto.randomUUID(),
      email: "browser-fixture@example.test",
    },
  });
  if (
    req.query.microsoft === "access_denied" ||
    req.query.microsoft === "unauthorized_client"
  )
    microsoftPolicy.set(user.id, req.query.microsoft);
  const auth = await db.googleAuthorization.create({
    data: {
      userId: user.id,
      subject: user.googleSubject,
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/calendar.events.owned",
      ],
    },
  });
  const source = await db.sourceConnection.create({
    data: {
      userId: user.id,
      authorizationId: auth.id,
      externalAccountId: user.googleSubject,
    },
  });
  if (req.query.automation === "attention") {
    const actor = { userId: user.id };
    const p = await getPolicy(actor);
    await savePolicy(actor, p.revision, {
      enabled: true,
      pollGmail: false,
      rules: [
        { connectionId: source.id, category: "exam_quiz", action: "auto" },
      ],
    });
    await importMessages(
      actor,
      ["auto-question", "auto-problem", "auto-newsletter"],
      dependencies.gmail!,
    );
    await automationScheduler.tick(actor);
  }
  const s = await createSession(user.id);
  setSessionCookie(res, s.token, false);
  res.redirect("/");
});
harness.use(app);
harness.listen(4173, "127.0.0.1");
