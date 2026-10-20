import type { Express } from "express";
import { z } from "zod";
import type { MessageSourceAdapter } from "@hub/contracts";
import type { GmailGateway } from "../infrastructure/google/gmail.js";
import { requireActor } from "../middleware/auth.js";
import { importMessages } from "../application/importMessages.js";
export function importRoutes(
  app: Express,
  gmail: GmailGateway,
  outlook: MessageSourceAdapter,
) {
  app.get("/api/gmail/messages", requireActor, async (req, res) => {
    const pageToken = z
      .string()
      .max(2000)
      .optional()
      .parse(req.query.pageToken);
    res.json(await gmail.list(res.locals.actor, pageToken));
  });
  app.get("/api/outlook/messages", requireActor, async (req, res) => {
    const pageToken = z
      .string()
      .max(12000)
      .optional()
      .parse(req.query.pageToken);
    res.json(await outlook.list(res.locals.actor, pageToken));
  });
  app.post("/api/imports", requireActor, async (req, res) => {
    const input = z
      .object({
        provider: z.enum(["gmail", "outlook"]).default("gmail"),
        externalIds: z.array(z.string()),
      })
      .strict()
      .parse(req.body);
    res.json(
      await importMessages(
        res.locals.actor,
        input.externalIds,
        input.provider === "outlook" ? outlook : gmail,
      ),
    );
  });
}
