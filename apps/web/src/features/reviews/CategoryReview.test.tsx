// @vitest-environment jsdom
import { it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewDetail } from "./ReviewDetail.js";
import {
  EVENT_CATEGORY_LABELS,
  type ReviewDetail as Detail,
} from "@hub/contracts";
afterEach(cleanup);
const draft: Detail["draft"] = {
  title: "Synthetic Workshop",
  location: null,
  description: null,
  category: "event",
  eventCategory: "hackathon_workshop",
  temporal: {
    kind: "all_day",
    startDate: "2026-10-20",
    endExclusive: "2026-10-21",
  },
};
const detail: Detail = {
  id: "r",
  messageId: "m",
  revision: 1,
  status: "needs_review",
  draft,
  subject: "Synthetic Workshop",
  originalText: "Workshop",
  candidate: {
    draft,
    evidence: [
      {
        code: "category_keyword_hackathon_workshop",
        origin: "subject",
        text: "Workshop",
        start: 10,
        end: 18,
      },
    ],
    missingFields: [],
    validationIssues: [],
    extractionVersion: 2,
    confidence: null,
    classification: {
      version: 1,
      status: "classified",
      category: "hackathon_workshop",
      alternatives: [],
    },
  },
  approvedSnapshot: null,
  write: null,
  checksUnavailable: true,
};
const callbacks = {
  onApprove: async () => {},
  onSave: async () => {},
  onIgnore: async () => {},
  onRetry: async () => {},
  onDelete: async () => {},
};
it("shared labels and editable category save separately from original classification", async () => {
  const save = vi.fn(async (_draft: Detail["draft"]) => {});
  render(<ReviewDetail detail={detail} {...callbacks} onSave={save} />);
  const category = screen.getByLabelText("Category");
  expect((category as HTMLSelectElement).value).toBe("hackathon_workshop");
  for (const label of Object.values(EVENT_CATEGORY_LABELS))
    expect(screen.getByRole("option", { name: label })).toBeTruthy();
  await userEvent.selectOptions(category, "career");
  await userEvent.click(
    screen.getByRole("button", { name: "Save corrections" }),
  );
  expect(save.mock.calls[0]?.[0]).toMatchObject({ eventCategory: "career" });
  expect(
    screen.getByText("Suggested category: Hackathon / workshop"),
  ).toBeTruthy();
});
it("ambiguous category displays alternatives without blocking a valid draft", () => {
  render(
    <ReviewDetail
      {...callbacks}
      detail={{
        ...detail,
        draft: { ...draft, eventCategory: "other" },
        candidate: {
          ...detail.candidate,
          classification: {
            version: 1,
            status: "ambiguous",
            category: "other",
            alternatives: ["career", "meeting"],
          },
        },
      }}
    />,
  );
  expect(
    screen.getByText(/Multiple category signals: Career event, Meeting/),
  ).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "Approve and add",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});
it("legacy absence survives mount and saving other fields", async () => {
  const { eventCategory: _removed, ...legacy } = draft;
  const { classification: _ignored, ...candidate } = detail.candidate;
  const save = vi.fn(async (_draft: Detail["draft"]) => {});
  render(
    <ReviewDetail
      {...callbacks}
      detail={{
        ...detail,
        draft: legacy,
        candidate: { ...candidate, draft: legacy },
      }}
      onSave={save}
    />,
  );
  expect((screen.getByLabelText("Category") as HTMLSelectElement).value).toBe(
    "",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Save corrections" }),
  );
  expect(save.mock.calls[0]?.[0]).not.toHaveProperty("eventCategory");
  expect(
    screen.getByText("No category classification recorded (legacy)."),
  ).toBeTruthy();
});
it.each(["approved", "ignored"] as const)(
  "category is locked for %s records",
  (status) => {
    render(
      <ReviewDetail
        detail={{
          ...detail,
          status,
          approvedSnapshot:
            status === "approved"
              ? (draft as Detail["approvedSnapshot"])
              : null,
        }}
        {...callbacks}
      />,
    );
    expect(
      (screen.getByLabelText("Category") as HTMLSelectElement).closest(
        "fieldset",
      )?.disabled,
    ).toBe(true);
  },
);
it("failed save preserves category correction and safe original evidence", async () => {
  render(
    <ReviewDetail
      detail={detail}
      {...callbacks}
      onSave={async () => {
        throw Error("PRIVATE-INTERNAL");
      }}
    />,
  );
  await userEvent.selectOptions(screen.getByLabelText("Category"), "social");
  await userEvent.click(
    screen.getByRole("button", { name: "Save corrections" }),
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect((screen.getByLabelText("Category") as HTMLSelectElement).value).toBe(
    "social",
  );
  expect(screen.queryByText(/PRIVATE-INTERNAL/)).toBeNull();
  expect(
    screen.getByText("Suggested category: Hackathon / workshop"),
  ).toBeTruthy();
});
it("selecting a category cannot remove date-only/title blockers", async () => {
  render(
    <ReviewDetail
      {...callbacks}
      detail={{
        ...detail,
        draft: {
          ...draft,
          title: "",
          temporal: {
            kind: "date_only",
            startDate: "2026-10-20",
            endDateInclusive: null,
          },
        },
      }}
    />,
  );
  await userEvent.selectOptions(screen.getByLabelText("Category"), "exam_quiz");
  expect(
    (
      screen.getByRole("button", {
        name: "Approve and add",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    screen.getByText("Enter an event title before approval."),
  ).toBeTruthy();
});
