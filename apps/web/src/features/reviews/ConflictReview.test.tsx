// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  act,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewDetail } from "./ReviewDetail.js";
import type { ReviewDetail as Detail, DuplicateCheck } from "@hub/contracts";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const draft = {
  title: "Orion workshop",
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
  originalText: null,
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
const callbacks = {
  onSave: async () => {},
  onIgnore: async () => {},
  onRetry: async () => {},
  onDelete: async () => {},
};
function result(matches = true): DuplicateCheck {
  return {
    reviewId: detail.id,
    revision: 1,
    checkedAt: new Date().toISOString(),
    window: null,
    local: { status: "checked" },
    google: { status: "checked" },
    matches: [],
    truncated: false,
    conflicts: {
      timezone: "America/Chicago",
      local: { status: "checked" },
      google: { status: "checked" },
      truncated: false,
      matches: matches
        ? [
            {
              key: "dentist",
              sources: ["google"],
              facts: {
                title: "Dentist appointment",
                location: null,
                temporal: draft.temporal,
              },
              kind: "timed_overlap",
              overlap: {
                start: "2026-10-10T15:30:00.000Z",
                end: "2026-10-10T16:00:00.000Z",
              },
            },
          ]
        : [],
    },
  };
}
it("shows a different commitment and exact overlap before deliberate approval", async () => {
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
  expect(await screen.findByText("Dentist appointment")).toBeTruthy();
  expect(screen.getByText(/30 minutes/)).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Scheduling conflicts" }),
  ).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "Approve and add anyway" }),
  );
  expect(approve).toHaveBeenCalledTimes(1);
  expect(check).toHaveBeenCalledTimes(1);
});
it("independent incomplete conflict coverage never becomes a clean approval", async () => {
  const r = result(false);
  r.conflicts!.google = { status: "partial", reason: "unsupported_events" };
  const approve = vi.fn();
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
  expect(await screen.findByText(/Conflict lookup incomplete/)).toBeTruthy();
  expect(
    screen.queryByText("No overlapping commitments in checked sources."),
  ).toBeNull();
});
it("corrections invalidate conflicts and require another check", async () => {
  const approve = vi.fn(),
    check = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result(false));
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
  expect(await screen.findByText("Dentist appointment")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("End", { exact: true }), {
    target: { value: "2026-10-10T12:00" },
  });
  fireEvent.change(screen.getByLabelText("Start", { exact: true }), {
    target: { value: "2026-10-10T11:00" },
  });
  expect(screen.queryByText("Dentist appointment")).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Approve and add" }),
  );
  expect(check).toHaveBeenCalledTimes(2);
  expect(approve).toHaveBeenCalledTimes(1);
});
it("rechecks expired conflict consent instead of silently approving", async () => {
  const now = Date.now(),
    approve = vi.fn(),
    check = vi.fn(async () => result());
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
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
  clock.mockReturnValue(now + 60001);
  await userEvent.click(
    screen.getByRole("button", { name: "Approve and add anyway" }),
  );
  expect(check).toHaveBeenCalledTimes(2);
  expect(approve).not.toHaveBeenCalled();
});
it("cannot approve after a pending combined check unmounts", async () => {
  let resolve!: (r: DuplicateCheck) => void;
  const promise = new Promise<DuplicateCheck>((r) => (resolve = r)),
    approve = vi.fn();
  const view = render(
    <ReviewDetail
      detail={detail}
      {...callbacks}
      onApprove={approve}
      onCheckDuplicates={() => promise}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Approve and add" }),
  );
  view.unmount();
  await act(async () => resolve(result(false)));
  expect(approve).not.toHaveBeenCalled();
});
it("labels all-day overlap as an advisory without changing candidate dates", async () => {
  const day = {
    ...draft,
    temporal: {
      kind: "all_day" as const,
      startDate: "2026-10-10",
      endExclusive: "2026-10-11",
    },
  };
  const d = { ...detail, draft: day };
  const r = result();
  r.conflicts!.matches[0].kind = "all_day_overlap";
  const approve = vi.fn();
  render(
    <ReviewDetail
      detail={d}
      {...callbacks}
      onApprove={approve}
      onCheckDuplicates={async () => r}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Approve and add" }),
  );
  expect(await screen.findByText("All-day overlap advisory")).toBeTruthy();
  expect(approve).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Start", { exact: true })).toHaveProperty(
    "value",
    "2026-10-10",
  );
});
