// @vitest-environment jsdom
import { it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App.js";
import { api, ApiError } from "./api/client.js";
import type { ReviewDetail } from "@hub/contracts";
vi.mock("./api/client.js", async (original) => ({
  ...(await original<typeof import("./api/client.js")>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const draft = {
  title: "Synthetic Workshop",
  category: "event" as const,
  location: null,
  description: null,
  temporal: {
    kind: "all_day" as const,
    startDate: "2026-10-20",
    endExclusive: "2026-10-21",
  },
};
const detail: ReviewDetail = {
  id: "r",
  messageId: "m",
  revision: 1,
  status: "needs_review",
  draft,
  subject: "Synthetic Workshop",
  originalText: "Synthetic workshop",
  candidate: {
    draft,
    evidence: [],
    missingFields: [],
    validationIssues: [],
    extractionVersion: 2,
    confidence: null,
  },
  approvedSnapshot: null,
  write: null,
  checksUnavailable: true,
};
it.each(["approval", "calendar"])(
  "%s remains busy and displays errors after the saved revision remounts",
  async (stage) => {
    let rejectRequest!: (reason: unknown) => void;
    const pending = new Promise((_, reject) => {
      rejectRequest = reject;
    });
    let current = detail;
    vi.mocked(api).mockImplementation(async (path, _schema, options = {}) => {
      if (path === "/api/me")
        return {
          user: {
            id: "u",
            email: "fixture@example.test",
            timezone: "America/Chicago",
          },
          csrf: "synthetic",
        } as any;
      if (path === "/api/connections")
        return { status: "connected", scopes: [] } as any;
      if (path === "/api/reviews")
        return {
          items: [
            {
              id: "r",
              status: current.status,
              title: draft.title,
              category: "event",
            },
          ],
          nextCursor: null,
        } as any;
      if (path === "/api/reviews/r" && options.method === "PATCH") {
        current = { ...detail, revision: 2 };
        return current as any;
      }
      if (path === "/api/reviews/r/duplicates")
        return {
          reviewId: "r",
          revision: current.revision,
          checkedAt: new Date().toISOString(),
          window: null,
          local: { status: "checked" },
          google: { status: "checked" },
          matches: [],
          truncated: false,
        } as any;
      if (path === "/api/reviews/r/approve") {
        if (stage === "approval") return pending as any;
        current = {
          ...current,
          revision: 3,
          status: "approved",
          approvedSnapshot: draft,
        };
        return current as any;
      }
      if (path === "/api/reviews/r/calendar") return pending as any;
      if (path === "/api/reviews/r") return current as any;
      throw Error("Unexpected synthetic path");
    });
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Open Synthetic Workshop" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Approve and add" }),
    );
    const target =
      stage === "approval"
        ? "/api/reviews/r/approve"
        : "/api/reviews/r/calendar";
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.some(([path]) => path === target)).toBe(
        true,
      ),
    );
    expect
      .soft(
        (
          screen.getByRole("button", {
            name:
              stage === "approval" ? "Approve and add" : "Retry calendar write",
          }) as HTMLButtonElement
        ).disabled,
      )
      .toBe(true);
    await act(async () => {
      rejectRequest(
        new ApiError(
          stage === "approval" ? "stale_review" : "provider_unavailable",
          409,
        ),
      );
      await pending.catch(() => {});
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      stage === "approval"
        ? "changed in another tab"
        : "temporarily unavailable",
    );
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      draft.title,
    );
    if (stage === "approval")
      expect(
        vi
          .mocked(api)
          .mock.calls.some(([path]) => path === "/api/reviews/r/calendar"),
      ).toBe(false);
  },
);
it.each([
  [null, "awaiting Calendar write"],
  ["writing", "Calendar write in progress"],
  ["failed", "Calendar write failed"],
  ["unknown", "Calendar outcome unknown"],
  ["added", "added to Calendar"],
] as const)(
  "queue displays the separate %s write outcome",
  async (status, label) => {
    const { deriveReviewState, evaluateDraft } = await import("@hub/contracts");
    const write = status
      ? {
          status,
          reason: status === "failed" ? "provider_rate_limited" : undefined,
        }
      : null;
    const persisted =
      status === "writing"
        ? "writing"
        : status === "added"
          ? "added"
          : "approved";
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/me")
        return {
          user: {
            id: "u",
            email: "fixture@example.test",
            timezone: "America/Chicago",
          },
          csrf: "synthetic",
        } as any;
      if (path === "/api/connections")
        return { status: "connected", scopes: [] } as any;
      if (path === "/api/reviews")
        return {
          items: [
            {
              id: "r",
              status: persisted,
              title: draft.title,
              category: "event",
              state: deriveReviewState(persisted, evaluateDraft(draft), write),
              write,
            },
          ],
          nextCursor: null,
        } as any;
      throw Error("Unexpected synthetic path");
    });
    render(<App />);
    expect(await screen.findByText(new RegExp(label))).toBeTruthy();
  },
);
