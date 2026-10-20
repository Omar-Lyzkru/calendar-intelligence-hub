// @vitest-environment jsdom
import { it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewDetail } from "./ReviewDetail.js";
import type { ReviewDetail as Detail } from "@hub/contracts";
afterEach(cleanup);
const draft = {
  title: "Synthetic Workshop",
  category: "event" as const,
  location: null,
  description: null,
  temporal: {
    kind: "timed" as const,
    start: "2026-10-20T19:00:00.000Z",
    end: "2026-10-20T20:00:00.000Z",
    timezone: "America/Chicago",
  },
};
const detail: Detail = {
  id: "synthetic-review",
  messageId: "synthetic-message",
  revision: 3,
  status: "needs_review",
  draft,
  originalText: "Synthetic original source",
  subject: null,
  candidate: {
    draft,
    evidence: [],
    missingFields: [],
    validationIssues: [],
    extractionVersion: 1,
    confidence: null,
  },
  approvedSnapshot: null,
  write: null,
  checksUnavailable: true,
  source: {
    provider: "discord",
    receivedAt: "2026-10-13T12:00:00.000Z",
    contentStatus: "available",
    notice: { kind: "changed", revision: 2, requiresConfirmation: true },
  },
};
const callbacks = {
  onSave: async () => {},
  onApprove: async () => {},
  onRetry: async () => {},
  onDelete: async () => {},
  onIgnore: async () => {},
};
it("a corrected ready draft cannot bypass a pending Discord source confirmation", async () => {
  let confirmed = false;
  render(
    <ReviewDetail
      detail={detail}
      {...callbacks}
      onConfirmSource={async () => {
        confirmed = true;
      }}
    />,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Approve and add",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByText(/Source: Discord/)).toBeTruthy();
  expect(screen.getByText(/original imported version/)).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm source decision" }),
  );
  expect(confirmed).toBe(false);
  await userEvent.click(
    screen.getByLabelText(/I checked the latest announcement/),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm source decision" }),
  );
  expect(confirmed).toBe(true);
});
it("acknowledged source notices remain visible while allowing a new explicit approval", () => {
  render(
    <ReviewDetail
      detail={{
        ...detail,
        source: {
          ...detail.source!,
          notice: { kind: "deleted", revision: 2, requiresConfirmation: false },
        },
      }}
      {...callbacks}
    />,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Approve and add",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(screen.getByText(/deleted in Discord/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Confirm source decision" }),
  ).toBeNull();
});
