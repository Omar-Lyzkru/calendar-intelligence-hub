// @vitest-environment jsdom
import { it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewDetail } from "./ReviewDetail.js";
import type { ReviewDetail as Detail } from "@hub/contracts";
afterEach(cleanup);
const detail: Detail = {
  id: "r",
  messageId: "m",
  revision: 1,
  status: "needs_review",
  draft: {
    title: "Workshop",
    category: "event",
    location: null,
    description: null,
    temporal: {
      kind: "timed",
      start: "2026-10-08T19:00:00.000Z",
      end: null,
      timezone: "America/Chicago",
    },
  },
  originalText: "<script>bad()</script>Workshop",
  subject: "Workshop",
  candidate: {
    draft: {
      title: "Workshop",
      category: "event",
      location: null,
      description: null,
      temporal: { kind: "unresolved", text: "", timezone: "America/Chicago" },
    },
    evidence: [{ code: "event_keyword", text: "Workshop" }],
    missingFields: ["end"],
    validationIssues: [],
    extractionVersion: 1,
    confidence: null,
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
it("invalid_candidate_cannot_submit", () => {
  render(<ReviewDetail detail={detail} {...callbacks} />);
  expect(
    (
      screen.getByRole("button", {
        name: "Approve and add",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
it("user_explicitly_confirms_duration", async () => {
  let approved = false;
  render(
    <ReviewDetail
      detail={detail}
      {...callbacks}
      onApprove={async () => {
        approved = true;
      }}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Propose 60 minutes" }),
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Approve and add",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await userEvent.click(
    screen.getByLabelText("I confirm this proposed duration"),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Approve and add" }),
  );
  expect(approved).toBe(true);
});
it("unknown_is_not_shown_as_added", () => {
  render(
    <ReviewDetail
      detail={{
        ...detail,
        status: "approved",
        write: { status: "unknown", reason: "provider_timeout" },
      }}
      {...callbacks}
    />,
  );
  expect(screen.getByText(/Outcome unknown/)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Retry calendar write" }),
  ).toBeTruthy();
  expect(screen.queryByText("Added to Google Calendar")).toBeNull();
});
it("expired_source_has_clear_unavailable_label", () => {
  render(
    <ReviewDetail detail={{ ...detail, originalText: null }} {...callbacks} />,
  );
  expect(screen.getByText("Original content expired or deleted.")).toBeTruthy();
});
it("message_html_renders_as_text_and_unavailable_checks_are_visible", () => {
  const { container } = render(<ReviewDetail detail={detail} {...callbacks} />);
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getByText("<script>bad()</script>Workshop")).toBeTruthy();
  expect(
    screen.getByText(/Duplicate and conflict checks are unavailable/),
  ).toBeTruthy();
});

it("write_failure_preserves_edits_and_approval", async () => {
  const { rerender } = render(
    <ReviewDetail
      detail={detail}
      {...callbacks}
      onSave={async () => {
        throw Error("Save failed; edits preserved.");
      }}
    />,
  );
  const title = screen.getByLabelText("Title");
  await userEvent.clear(title);
  await userEvent.type(title, "Corrected Workshop");
  await userEvent.click(
    screen.getByRole("button", { name: "Save corrections" }),
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
    "Corrected Workshop",
  );
  rerender(
    <ReviewDetail
      detail={{
        ...detail,
        status: "approved",
        write: { status: "failed", reason: "provider_rate_limited" },
      }}
      {...callbacks}
    />,
  );
  expect(screen.getByText(/Your approval is saved/)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Retry calendar write" }),
  ).toBeTruthy();
});
it("normal times hide occurrence choices and date-only requires explicit confirmation", async () => {
  const { unmount } = render(<ReviewDetail detail={detail} {...callbacks} />);
  expect(screen.queryByLabelText(/Daylight-saving offset/)).toBeNull();
  unmount();
  const dateOnly = {
    ...detail,
    draft: {
      ...detail.draft,
      temporal: {
        kind: "date_only" as const,
        startDate: "2026-10-20",
        endDateInclusive: null,
      },
    },
  };
  render(<ReviewDetail detail={dateOnly} {...callbacks} />);
  expect(
    (
      screen.getByRole("button", {
        name: "Approve and add",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm as all-day" }),
  );
  expect(
    (screen.getByLabelText("End date (exclusive)") as HTMLInputElement).value,
  ).toBe("2026-10-21");
  expect(
    (
      screen.getByRole("button", {
        name: "Approve and add",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});
it("repeated endpoints expose independent real-offset choices", async () => {
  render(
    <ReviewDetail
      detail={{
        ...detail,
        draft: {
          ...detail.draft,
          temporal: {
            kind: "timed",
            start: "2026-11-01T06:30:00.000Z",
            end: "2026-11-01T07:45:00.000Z",
            timezone: "America/Chicago",
          },
        },
      }}
      {...callbacks}
    />,
  );
  expect(
    (screen.getByLabelText("Start occurrence") as HTMLSelectElement).value,
  ).toBe("earlier");
  expect(
    (screen.getByLabelText("End occurrence") as HTMLSelectElement).value,
  ).toBe("later");
  await userEvent.clear(screen.getByLabelText("End"));
  expect(
    (screen.getByLabelText("Start occurrence") as HTMLSelectElement).value,
  ).toBe("earlier");
  expect(screen.queryByLabelText("End occurrence")).toBeNull();
});
it("invalid zone cannot be saved even with an incomplete start", async () => {
  render(
    <ReviewDetail
      detail={{
        ...detail,
        draft: {
          ...detail.draft,
          temporal: {
            kind: "unresolved",
            text: "",
            timezone: "America/Chicago",
          },
        },
      }}
      {...callbacks}
    />,
  );
  await userEvent.clear(screen.getByLabelText("Timezone"));
  await userEvent.type(screen.getByLabelText("Timezone"), "Invalid/Zone");
  expect(
    (
      screen.getByRole("button", {
        name: "Save corrections",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("empty-title date-only draft shows simultaneous blockers and can save or ignore without a fallback title", async () => {
  let saved: Detail["draft"] | undefined;
  render(
    <ReviewDetail
      {...callbacks}
      detail={{
        ...detail,
        draft: {
          ...detail.draft,
          title: "",
          temporal: {
            kind: "date_only",
            startDate: "2026-10-20",
            endDateInclusive: null,
          },
        },
      }}
      onSave={async (draft) => {
        saved = draft;
      }}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Untitled candidate" }),
  ).toBeTruthy();
  expect(
    screen.getByText("Enter an event title before approval."),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Confirm an all-day event or supply a specific time before approval.",
    ),
  ).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "Save corrections",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  await userEvent.click(
    screen.getByRole("button", { name: "Save corrections" }),
  );
  expect(saved?.title).toBe("");
  expect(
    (screen.getByRole("button", { name: "Ignore" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
it("correcting current fields enables approval despite original extraction warnings and optional absence", async () => {
  render(
    <ReviewDetail
      {...callbacks}
      detail={{
        ...detail,
        draft: {
          ...detail.draft,
          title: "",
          temporal: {
            kind: "date_only",
            startDate: "2026-10-20",
            endDateInclusive: null,
          },
        },
        candidate: {
          ...detail.candidate,
          validationIssues: ["Original unresolved timing"],
        },
      }}
    />,
  );
  await userEvent.type(screen.getByLabelText("Title"), "Exam");
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm as all-day" }),
  );
  expect(screen.getByText("Ready for approval")).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Original extraction" }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Original extraction recorded uncertainty. Check the source and current fields.",
    ),
  ).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "Approve and add",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});
it("Calendar failure displays a safe explanation rather than an arbitrary stored reason", () => {
  render(
    <ReviewDetail
      {...callbacks}
      detail={{
        ...detail,
        status: "approved",
        write: { status: "failed", reason: "PRIVATE-SENTINEL" },
      }}
    />,
  );
  expect(screen.queryByText(/PRIVATE-SENTINEL/)).toBeNull();
  expect(screen.getByText(/Your approval is saved/)).toBeTruthy();
});

it("server blockers remain visible without overwriting corrected draft", async () => {
  const { ApiError } = await import("../../api/client.js");
  render(
    <ReviewDetail
      detail={detail}
      {...callbacks}
      onSave={async () => {
        throw new ApiError("incomplete_event", 422, [
          {
            field: "title",
            code: "title_required",
            kind: "missing",
            message: "Enter an event title before approval.",
          },
        ]);
      }}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Save corrections" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Enter an event title before approval.",
  );
  expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
    "Workshop",
  );
});
