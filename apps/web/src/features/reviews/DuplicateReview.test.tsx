// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewDetail } from "./ReviewDetail.js";
import type { ReviewDetail as Detail, DuplicateCheck } from "@hub/contracts";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const draft = {
  title: "CodeRED Orion",
  location: null,
  description: null,
  category: "event" as const,
  temporal: {
    kind: "timed" as const,
    start: "2026-10-10T15:00:00.000Z",
    end: "2026-10-10T16:00:00.000Z",
    timezone: "America/Chicago",
  },
};
const detail: Detail = {
  id: "00000000-0000-4000-8000-000000000001",
  messageId: "m",
  revision: 1,
  status: "needs_review",
  draft,
  originalText: "Synthetic message",
  subject: draft.title,
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
const result = (matches = true): DuplicateCheck => ({
  reviewId: detail.id,
  revision: 1,
  checkedAt: new Date().toISOString(),
  window: null,
  local: { status: "checked" },
  google: { status: "checked" },
  truncated: false,
  matches: matches
    ? [
        {
          key: "manual",
          strength: "strong_possible",
          sources: ["google"],
          facts: {
            title: "CodeRED Orion Hackathon",
            location: "Hall",
            temporal: draft.temporal,
          },
          evidence: ["similar_title", "same_time"],
          providerEventId: "manual",
          calendarId: "primary",
        },
      ]
    : [],
});
const callbacks = {
  onSave: async () => {},
  onIgnore: async () => {},
  onRetry: async () => {},
  onDelete: async () => {},
};
it("checks before approval, shows reasons and allows deliberate advisory override", async () => {
  const approve = vi.fn(),
    check = vi.fn(async () => result());
  render(
    <ReviewDetail
      detail={detail}
      {...callbacks}
      onApprove={approve}
      onCheckDuplicates={check}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Approve and add" }),
  );
  expect(approve).not.toHaveBeenCalled();
  expect(await screen.findByText("CodeRED Orion Hackathon")).toBeTruthy();
  expect(screen.getByText("Similar title")).toBeTruthy();
  expect(screen.getByText("Google Calendar")).toBeTruthy();
  expect(screen.getByText("Ready for approval")).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "Approve and add anyway" }),
  );
  expect(approve).toHaveBeenCalledTimes(1);
  expect(check).toHaveBeenCalledTimes(1);
});
it("fully checked absence proceeds without a warning; edits invalidate cached matches", async () => {
  const approve = vi.fn(),
    check = vi.fn(async () => result());
  render(
    <ReviewDetail
      detail={detail}
      {...callbacks}
      onApprove={approve}
      onCheckDuplicates={check}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Check possible duplicates" }),
  );
  await screen.findByText("CodeRED Orion Hackathon");
  await userEvent.type(screen.getByLabelText("Title"), " changed");
  expect(
    screen.queryByRole("button", { name: "Approve and add anyway" }),
  ).toBeNull();
  check.mockResolvedValue(result(false));
  await userEvent.click(
    screen.getByRole("button", { name: "Approve and add" }),
  );
  expect(check).toHaveBeenCalledTimes(2);
  expect(approve).toHaveBeenCalledTimes(1);
});
it("lookup failure is incomplete and never clean; retry and deliberate override preserve edits", async () => {
  const approve = vi.fn(),
    check = vi.fn(async () => {
      throw Error("PRIVATE PROVIDER SECRET");
    });
  render(
    <ReviewDetail
      detail={detail}
      {...callbacks}
      onApprove={approve}
      onCheckDuplicates={check}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Approve and add" }),
  );
  expect(approve).not.toHaveBeenCalled();
  expect(
    await screen.findByText(/Possible duplicate check unavailable/),
  ).toBeTruthy();
  expect(document.body.textContent).not.toContain("PRIVATE PROVIDER");
  expect(screen.queryByText(/No possible matches/)).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Approve and add anyway" }),
  );
  expect(approve).toHaveBeenCalledTimes(1);
});
it("partial coverage with no matches still pauses approval", async () => {
  const approve = vi.fn(),
    r = {
      ...result(false),
      google: { status: "partial" as const, reason: "limit_reached" as const },
    };
  render(
    <ReviewDetail
      detail={detail}
      {...callbacks}
      onApprove={approve}
      onCheckDuplicates={async () => r}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Approve and add" }),
  );
  expect(approve).not.toHaveBeenCalled();
  expect(await screen.findByText(/page or result limit/i)).toBeTruthy();
  expect(
    screen.queryByText(/No possible matches in checked sources/),
  ).toBeNull();
});
it("expired checks are repeated, stale responses cannot approve, and waiting locks edits", async () => {
  const approve = vi.fn(),
    check = vi.fn(async () => result());
  render(
    <ReviewDetail
      detail={detail}
      {...callbacks}
      onApprove={approve}
      onCheckDuplicates={check}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Check possible duplicates" }),
  );
  await screen.findByText("CodeRED Orion Hackathon");
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 61000);
  check.mockResolvedValue({ ...result(false), revision: 2 });
  await userEvent.click(
    screen.getByRole("button", { name: "Approve and add anyway" }),
  );
  expect(check).toHaveBeenCalledTimes(2);
  expect(approve).not.toHaveBeenCalled();
  expect(await screen.findByRole("alert")).toBeTruthy();
});

it("pending rechecks disable match navigation and cannot approve after unmount", async () => {
  const approve = vi.fn(),
    r = result();
  r.matches[0].reviewId = "00000000-0000-4000-8000-000000000002";
  r.matches[0].sources = ["local"];
  let resolve!: (r: DuplicateCheck) => void;
  const pending = new Promise<DuplicateCheck>((done) => (resolve = done));
  const check = vi.fn(async () => r);
  const view = render(
    <ReviewDetail
      detail={detail}
      {...callbacks}
      onApprove={approve}
      onCheckDuplicates={check}
      onOpenMatch={() => view.unmount()}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Check possible duplicates" }),
  );
  await screen.findByText("CodeRED Orion Hackathon");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
  check.mockImplementation(() => pending);
  await userEvent.click(
    screen.getByRole("button", { name: "Approve and add" }),
  );
  expect
    .soft(
      (
        screen.getByRole("button", {
          name: "Open local review",
        }) as HTMLButtonElement
      ).disabled,
    )
    .toBe(true);
  expect(
    (screen.getByLabelText("Title") as HTMLInputElement).disabled ||
      screen.getByLabelText("Title").closest("fieldset")?.disabled,
  ).toBe(true);
  view.unmount();
  await act(async () => {
    resolve(result(false));
    await pending;
  });
  expect(approve).not.toHaveBeenCalled();
});
