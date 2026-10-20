import { z } from "zod";
import { createHash } from "node:crypto";
import {
  AppError,
  canonicalCalendarDate,
  canonicalInstant,
  validateReadyEvent,
  DuplicateWindowSchema,
  type DuplicateWindow,
  type DuplicateRecord,
  type DuplicateCoverage,
  type Actor,
  type CalendarReceipt,
  type ReadyEvent,
} from "@hub/contracts";
import { providerClient } from "./providerClient.js";
import { CALENDAR_SCOPE } from "./oauth.js";
import type { Config } from "../../config/env.js";
export interface CalendarGateway {
  list?(
    actor: Actor,
    window: DuplicateWindow,
  ): Promise<{ events: DuplicateRecord[]; coverage: DuplicateCoverage }>;
  get(actor: Actor, eventId: string): Promise<CalendarReceipt | null>;
  insert(
    actor: Actor,
    eventId: string,
    event: ReadyEvent,
    payloadHash: string,
  ): Promise<CalendarReceipt>;
}
export function toCalendarPayload(event: ReadyEvent) {
  const validated = validateReadyEvent(event);
  if (!validated.ok) throw new AppError("invalid_calendar_event", 422);
  event = validated.event;
  const t = event.temporal;
  return {
    summary: event.title,
    location: event.location || "",
    description: event.description || "",
    start:
      t.kind === "timed"
        ? { dateTime: t.start, timeZone: t.timezone }
        : { date: t.startDate },
    end:
      t.kind === "timed"
        ? { dateTime: t.end, timeZone: t.timezone }
        : { date: t.endExclusive },
  };
}
// Hash commitment fields, not API formatting or the internal category.
export function payloadHash(event: ReadyEvent) {
  const p = toCalendarPayload(event);
  return hashCommitment(p);
}
const endpoint = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
  timeZone: z.string().optional(),
});
const eventSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().default(""),
  location: z.string().default(""),
  description: z.string().default(""),
  start: endpoint,
  end: endpoint,
  htmlLink: z.string().optional(),
  extendedProperties: z
    .object({ private: z.record(z.string(), z.string()).optional() })
    .optional(),
});
type CalendarPayload = {
  summary: string;
  location: string;
  description: string;
  start: { date?: string; dateTime?: string };
  end: { date?: string; dateTime?: string };
};
function hashCommitment(p: CalendarPayload) {
  const normalize = (v: { date?: string; dateTime?: string }) => {
    if ((v.date !== undefined) === (v.dateTime !== undefined))
      throw new AppError("invalid_provider_time", 503);
    if (v.date !== undefined) {
      const parsed = canonicalCalendarDate(v.date);
      if (!parsed.ok) throw new AppError("invalid_provider_time", 503);
      return { date: parsed.date };
    }
    const parsed = canonicalInstant(v.dateTime);
    if (!parsed.ok) throw new AppError("invalid_provider_time", 503);
    return { dateTime: parsed.instant };
  };
  const start = normalize(p.start);
  const end = normalize(p.end);
  if (
    "date" in start !== "date" in end ||
    (start.date ?? start.dateTime)! >= (end.date ?? end.dateTime)!
  )
    throw new AppError("invalid_provider_time", 503);
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: p.summary,
        location: p.location,
        description: p.description,
        start,
        end,
      }),
    )
    .digest("hex");
}
export function calendarReceipt(payload: unknown): CalendarReceipt {
  const p = eventSchema.parse(payload);
  const actual = hashCommitment(p);
  const marker = p.extendedProperties?.private?.hubPayloadHash;
  const hash =
    marker === actual && p.status !== "cancelled" ? actual : "mismatch";
  const link =
    p.htmlLink &&
    (() => {
      try {
        return (
          new URL(p.htmlLink).protocol === "https:" &&
          new URL(p.htmlLink).hostname === "calendar.google.com"
        );
      } catch {
        return false;
      }
    })()
      ? p.htmlLink
      : "https://calendar.google.com/calendar/u/0/r";
  return {
    providerEventId: p.id,
    calendarId: "primary",
    htmlLink: link,
    payloadHash: hash,
  };
}
function providerError(error: unknown): AppError {
  const e = error as { response?: { status?: number }; code?: string };
  return new AppError(
    e.response?.status === 409
      ? "provider_collision"
      : e.response?.status === 429
        ? "provider_rate_limited"
        : "provider_unavailable",
    e.response?.status === 409 ? 409 : e.response?.status === 429 ? 429 : 503,
  );
}
const duplicateEnvelope = z.object({
  timeZone: z.string().optional(),
  items: z.array(z.unknown()).default([]),
  nextPageToken: z.string().min(1).optional(),
});
const duplicateEvent = z.object({
  transparency: z.string().optional(),
  endTimeUnspecified: z.boolean().optional(),
  id: z.string().min(1),
  status: z.string().optional(),
  summary: z.string().max(300).default(""),
  location: z.string().max(1000).default(""),
  start: endpoint,
  end: endpoint,
  htmlLink: z.string().optional(),
});
function projectedCalendarEvent(
  input: unknown,
  calendarTimezone?: string,
): DuplicateRecord | null {
  const e = duplicateEvent.parse(input);
  if (e.status === "cancelled") return null;
  let temporal: DuplicateRecord["temporal"];
  if (
    e.start.date !== undefined &&
    e.end.date !== undefined &&
    e.start.dateTime === undefined &&
    e.end.dateTime === undefined
  ) {
    const a = canonicalCalendarDate(e.start.date),
      b = canonicalCalendarDate(e.end.date);
    if (!a.ok || !b.ok || a.date >= b.date) throw Error("unsupported");
    temporal = { kind: "all_day", startDate: a.date, endExclusive: b.date };
  } else if (
    e.start.dateTime !== undefined &&
    e.end.dateTime !== undefined &&
    e.start.date === undefined &&
    e.end.date === undefined
  ) {
    const a = canonicalInstant(e.start.dateTime),
      b = canonicalInstant(e.end.dateTime);
    if (!a.ok || !b.ok || a.instant >= b.instant) throw Error("unsupported");
    const zone = e.start.timeZone || "UTC";
    new Intl.DateTimeFormat("en", { timeZone: zone });
    temporal = {
      kind: "timed",
      start: a.instant,
      end: b.instant,
      timezone: zone,
    };
  } else throw Error("unsupported");
  let htmlLink: string | undefined;
  try {
    const u = new URL(e.htmlLink || "");
    if (u.protocol === "https:" && u.hostname === "calendar.google.com")
      htmlLink = e.htmlLink;
  } catch {}
  return {
    key: "google:" + e.id,
    source: "google",
    availability: e.endTimeUnspecified
      ? "unknown"
      : e.transparency === "transparent"
        ? "free"
        : !e.transparency || e.transparency === "opaque"
          ? "busy"
          : "unknown",
    calendarTimezone,
    title: e.summary,
    location: e.location || null,
    temporal,
    providerEventId: e.id,
    calendarId: "primary",
    htmlLink,
  };
}
function duplicateFailure(error: unknown): DuplicateCoverage["reason"] {
  if (error instanceof AppError && error.code === "reauthorization_required")
    return "reauthorization_required";
  return (error as { response?: { status?: number } })?.response?.status === 429
    ? "provider_rate_limited"
    : "provider_unavailable";
}

export function googleCalendar(config: Config): CalendarGateway {
  return {
    list: async (actor, window) => {
      const bounded = DuplicateWindowSchema.safeParse(window);
      if (
        !bounded.success ||
        Date.parse(window.timeMax) <= Date.parse(window.timeMin) ||
        Date.parse(window.timeMax) - Date.parse(window.timeMin) > 35 * 86400000
      )
        throw new AppError("invalid_duplicate_window", 422);
      const events: DuplicateRecord[] = [];
      let token: string | undefined;
      let partial = false;
      const seen = new Set<string>();
      try {
        const client = await providerClient(actor, CALENDAR_SCOPE, config);
        for (let page = 0; page < 3; page++) {
          const result = duplicateEnvelope.parse(
            (
              await client.request<unknown>({
                url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
                method: "GET",
                params: {
                  timeMin: window.timeMin,
                  timeMax: window.timeMax,
                  singleEvents: true,
                  orderBy: "startTime",
                  showDeleted: false,
                  maxResults: 50,
                  fields:
                    "nextPageToken,timeZone,items(id,status,summary,location,start,end,htmlLink,transparency,endTimeUnspecified)",
                  ...(token ? { pageToken: token } : {}),
                },
                timeout: config.PROVIDER_TIMEOUT_MS,
                retry: false,
              })
            ).data,
          );
          if (result.items.length > 50) partial = true;
          for (const item of result.items.slice(0, 50)) {
            try {
              const event = projectedCalendarEvent(item, result.timeZone);
              if (
                event &&
                !events.some((v) => v.providerEventId === event.providerEventId)
              )
                events.push(event);
            } catch {
              partial = true;
            }
          }
          token = result.nextPageToken;
          if (!token)
            return {
              events,
              coverage: partial
                ? { status: "partial", reason: "unsupported_events" }
                : { status: "checked" },
            };
          if (seen.has(token))
            return {
              events,
              coverage: { status: "partial", reason: "limit_reached" },
            };
          seen.add(token);
        }
        return {
          events,
          coverage: { status: "partial", reason: "limit_reached" },
        };
      } catch (error) {
        return {
          events,
          coverage: {
            status: events.length ? "partial" : "unavailable",
            reason: duplicateFailure(error),
          },
        };
      }
    },
    get: async (actor, id) => {
      const client = await providerClient(actor, CALENDAR_SCOPE, config);
      try {
        return calendarReceipt(
          (
            await client.request<unknown>({
              url:
                "https://www.googleapis.com/calendar/v3/calendars/primary/events/" +
                encodeURIComponent(id),
              timeout: config.PROVIDER_TIMEOUT_MS,
              retry: false,
            })
          ).data,
        );
      } catch (error) {
        if (
          (error as { response?: { status?: number } }).response?.status === 404
        )
          return null;
        throw providerError(error);
      }
    },
    insert: async (actor, id, event, hash) => {
      const payload = toCalendarPayload(event);
      const client = await providerClient(actor, CALENDAR_SCOPE, config);
      try {
        return calendarReceipt(
          (
            await client.request<unknown>({
              url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
              method: "POST",
              params: { sendUpdates: "none" },
              data: {
                ...payload,
                id,
                extendedProperties: { private: { hubPayloadHash: hash } },
              },
              timeout: config.PROVIDER_TIMEOUT_MS,
              retry: false,
            })
          ).data,
        );
      } catch (error) {
        throw providerError(error);
      }
    },
  };
}
