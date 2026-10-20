// @vitest-environment jsdom
import { it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Activity } from "./Activity.js";
import { api } from "../../api/client.js";
vi.mock("../../api/client.js", () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("activity separates successful actions, questions, skips and problems", async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path === "/api/automation/policy"
      ? ({
          enabled: true,
          pollGmail: false,
          rules: [],
          revision: 1,
          enabledAt: null,
          liveWritesEnabled: false,
        } as any)
      : ({
          items: [
            {
              id: "1",
              reviewId: "r",
              title: "Exam",
              decision: "auto_handle",
              reason: "added",
              explanation: "Added with a receipt",
              createdAt: "2026-10-14T12:00:00Z",
              question: null,
            },
            {
              id: "2",
              reviewId: null,
              title: "Newsletter",
              decision: "skip",
              reason: "no_event",
              explanation: "No commitment detected",
              createdAt: "2026-10-14T12:00:00Z",
              question: null,
            },
            {
              id: "3",
              reviewId: "r3",
              title: "Workshop",
              decision: "blocked",
              reason: "checks_unavailable",
              explanation: "Checks unavailable; no action",
              createdAt: "2026-10-14T12:00:00Z",
              question: null,
            },
            {
              id: "4",
              reviewId: "r4",
              title: "Untitled candidate",
              decision: "ask_user",
              reason: "title_required",
              explanation: "Name this event",
              createdAt: "2026-10-14T12:00:00Z",
              question: {
                id: "q",
                kind: "title",
                reviewRevision: 1,
                prompt: "Name this event",
              },
            },
          ],
          polls: [],
          nextCursor: null,
        } as any),
  );
  render(<Activity onOpenReview={() => {}} onSettings={() => {}} />);
  expect(
    await screen.findByRole("heading", { name: "Needs you" }),
  ).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Recent activity" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Skipped" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Problems" })).toBeTruthy();
  expect(screen.getByText("Checks unavailable; no action")).toBeTruthy();
});
it("failed activity load offers manual fallback without private error text", async () => {
  vi.mocked(api).mockRejectedValue(Error("PRIVATE_ACTIVITY_SENTINEL"));
  render(<Activity onOpenReview={() => {}} onSettings={() => {}} />);
  expect((await screen.findByRole("alert")).textContent).not.toContain(
    "PRIVATE_ACTIVITY_SENTINEL",
  );
});
