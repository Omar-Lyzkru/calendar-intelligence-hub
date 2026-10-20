import { it, expect } from "vitest";
import { safeFailure, historyDisplay } from "./processing.js";
it("failure stage and recovery distinguish technical causes without leaking unknown codes", () => {
  expect(safeFailure("fetch", "provider_rate_limited")).toMatchObject({
    stage: "fetch",
    code: "provider_rate_limited",
    recovery: { action: "retry_import", canRetryNow: true },
  });
  expect(safeFailure("normalize", "invalid_provider_payload")).toMatchObject({
    stage: "normalize",
    recovery: { action: "resolve_issue", canRetryNow: false },
  });
  expect(safeFailure("fetch", "reauthorization_required").recovery.action).toBe(
    "reconnect",
  );
  expect(safeFailure("process", "PRIVATE-SENTINEL")).toMatchObject({
    code: "processing_failed",
    stage: "process",
  });
  expect(
    JSON.stringify(safeFailure("persist", "PRIVATE-SENTINEL")),
  ).not.toContain("PRIVATE-SENTINEL");
});
it("history displays known actions but never arbitrary stored reasons", () => {
  expect(historyDisplay("message_processed", "review").label).toBe(
    "Candidate created for review",
  );
  expect(
    historyDisplay("import_process_failed", "PRIVATE-SENTINEL").message,
  ).not.toContain("PRIVATE-SENTINEL");
  expect(
    JSON.stringify(historyDisplay("PRIVATE-SENTINEL", "PRIVATE-SENTINEL")),
  ).not.toContain("PRIVATE-SENTINEL");
});
it("Outlook connection history uses readable fixed provider labels", () => {
  expect(historyDisplay("connection_authorized", "outlook")).toEqual({
    label: "Outlook connected",
  });
  expect(historyDisplay("microsoft_disconnected")).toEqual({
    label: "Outlook disconnected",
  });
  expect(
    historyDisplay("connection_authorized", "PRIVATE-SENTINEL").message,
  ).not.toContain("PRIVATE-SENTINEL");
});

it("known Gmail fetch failures retain manual retry guidance", () => {
  expect(
    safeFailure("fetch", "gmail_fetch_unavailable").recovery,
  ).toMatchObject({ action: "retry_import", canRetryNow: true });
});

import { safeErrorCode } from "./processing.js";
it("public exception codes use an allowlist while existing auth and write codes stay compatible", () => {
  expect(safeErrorCode("PRIVATE-SENTINEL")).toBe("internal_error");
  expect(safeErrorCode("invalid_state")).toBe("invalid_state");
  expect(safeErrorCode("PRIVATE-SENTINEL", "provider_unavailable")).toBe(
    "provider_unavailable",
  );
});

import { safeMessage } from "./processing.js";
it.each(["toString", "constructor", "__proto__"])(
  "inherited key %s receives a fixed safe string",
  (code) => {
    expect(typeof safeMessage(code)).toBe("string");
    expect(historyDisplay(code, code).label).toBe("History recorded");
    expect(typeof historyDisplay(code, code).message).toBe("string");
  },
);
it("automation success history explains the action without a false error", () => {
  expect(historyDisplay("automation_auto_handle", "added")).toMatchObject({
    label: "Automatic Calendar action",
    message: "Added to Calendar with a confirmed receipt.",
  });
  expect(historyDisplay("automation_skip", "no_event").label).toBe(
    "Automation skipped an item",
  );
});
