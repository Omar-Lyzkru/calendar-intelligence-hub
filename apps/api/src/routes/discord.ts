import type { Express } from "express";
import { z } from "zod";
import { AppError } from "@hub/contracts";
import type { Config } from "../config/env.js";
import { requireActor } from "../middleware/auth.js";
import { db } from "../infrastructure/persistence/db.js";
import { readDiscordConfig } from "../infrastructure/discord/config.js";
import { DiscordRest } from "../infrastructure/discord/rest.js";
import type { DiscordRuntime } from "../infrastructure/discord/runtime.js";
import {
  connectRelay,
  disconnectRelay,
  getRelayStatus,
} from "../infrastructure/discord/connections.js";
import { confirmDiscordSource } from "../application/discordIngestion.js";
export type DiscordControl = Pick<
  DiscordRuntime,
  "status" | "reconnect" | "stop"
>;
export function discordRoutes(
  app: Express,
  config: Config,
  runtime: DiscordControl | null,
  rest?: Pick<DiscordRest, "checkAccess">,
) {
  const scoped = readDiscordConfig({
    DISCORD_BOT_TOKEN: config.DISCORD_BOT_TOKEN,
    DISCORD_GUILD_ID: config.DISCORD_GUILD_ID,
    DISCORD_CHANNEL_IDS: config.DISCORD_CHANNEL_IDS,
  });
  const status = async (actor: { userId: string }) => {
    const binding = await getRelayStatus(actor, scoped);
    return {
      ...binding,
      runtime:
        binding.status === "connected" && runtime
          ? runtime.status()
          : { state: "idle", coverage: "not_checked" },
    };
  };
  app.get("/api/connections/discord", requireActor, async (_req, res) =>
    res.json(await status(res.locals.actor)),
  );
  app.post("/api/connections/discord", requireActor, async (req, res) => {
    z.object({})
      .strict()
      .parse(req.body || {});
    if (!scoped || !runtime) throw new AppError("discord_not_configured", 503);
    await (rest || new DiscordRest(scoped)).checkAccess();
    await connectRelay(res.locals.actor, scoped);
    await runtime.reconnect();
    res.json(await status(res.locals.actor));
  });
  app.delete("/api/connections/discord", requireActor, async (_req, res) => {
    const owned = scoped
      ? await db.discordRelay.findFirst({
          where: { userId: res.locals.actor.userId, guildId: scoped.guildId },
        })
      : null;
    await disconnectRelay(res.locals.actor);
    if (owned) await runtime?.stop();
    res.json(await status(res.locals.actor));
  });
  app.get("/api/discord/messages", requireActor, async (req, res) => {
    const cursor = z.uuid().optional().parse(req.query.pageToken);
    if (
      cursor &&
      !(await db.normalizedMessage.findFirst({
        where: {
          id: cursor,
          userId: res.locals.actor.userId,
          source: "discord",
        },
      }))
    )
      throw new AppError("not_found", 404);
    const messages = await db.normalizedMessage.findMany({
      where: {
        userId: res.locals.actor.userId,
        source: "discord",
        connection: { userId: res.locals.actor.userId, provider: "discord" },
      },
      include: { detected: { include: { review: true } } },
      orderBy: [{ ingestedAt: "desc" }, { id: "desc" }],
      take: 21,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    // Failed/unsupported sources have no normalized body: expose only safe receipt status, never false no-event.
    const failures = cursor
      ? []
      : await db.discordObservation.findMany({
          where: {
            status: "failed",
            connection: {
              userId: res.locals.actor.userId,
              provider: "discord",
            },
          },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: { id: true, errorCode: true },
        });
    res.json({
      items: messages.slice(0, 20).map((m) => ({
        id: m.id,
        title:
          m.detected?.review?.draft &&
          typeof m.detected.review.draft === "object" &&
          "title" in m.detected.review.draft
            ? String(m.detected.review.draft.title)
            : "Announcement",
        status: m.detected ? "review" : "no_event",
        reviewId: m.detected?.review?.id,
        receivedAt: m.receivedAt.toISOString(),
      })),
      failures: failures.map((f) => ({
        id: f.id,
        reason: f.errorCode || "discord_invalid_payload",
      })),
      nextPageToken: messages.length > 20 ? messages[19].id : undefined,
    });
  });
  app.post(
    "/api/reviews/:id/source-confirmation",
    requireActor,
    async (req, res) => {
      const input = z
        .object({
          expectedRevision: z.number().int().positive(),
          sourceRevision: z.number().int().positive(),
        })
        .strict()
        .parse(req.body);
      res.json(
        await confirmDiscordSource(
          res.locals.actor,
          z.uuid().parse(req.params.id),
          input.expectedRevision,
          input.sourceRevision,
        ),
      );
    },
  );
}
