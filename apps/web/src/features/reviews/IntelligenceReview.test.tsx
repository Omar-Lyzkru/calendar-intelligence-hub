// @vitest-environment jsdom
import { it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewDetail } from "./ReviewDetail.js";
import {
  evaluateConfidence,
  type ReviewDetail as Detail,
} from "@hub/contracts";
afterEach(cleanup);
const draft: Detail["draft"] = {
  title: "Workshop",
  location: null,
  description: null,
  category: "event",
  eventCategory: "hackathon_workshop",
  temporal: {
    kind: "timed",
    start: "2026-10-20T15:00:00Z",
    end: "2026-10-20T16:00:00Z",
    timezone: "America/Chicago",
    timezoneProvenance: "explicit",
  },
};
const evidence = [
  {
    code: "explicit_date",
    origin: "content" as const,
    text: "October 20, 2026",
  },
  { code: "explicit_time", origin: "content" as const, text: "10:00 AM" },
  { code: "event_keyword", text: "Workshop" },
];
const detail: Detail = {
  id: "r",
  messageId: "m",
  revision: 1,
  status: "needs_review",
  draft,
  subject: "Workshop",
  originalText: "Synthetic workshop",
  candidate: {
    draft,
    evidence,
    missingFields: [],
    validationIssues: [],
    extractionVersion: 2,
    confidence: evaluateConfidence({ draft, evidence }),
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
it("Outlook source is named while shared extraction support remains unchanged", () => {
  render(
    <ReviewDetail
      detail={{
        ...detail,
        source: {
          provider: "outlook",
          receivedAt: "2026-10-12T12:00:00.000Z",
          contentStatus: "available",
        },
      }}
      {...callbacks}
    />,
  );
  expect(screen.getByText(/Source: Outlook. Received:/)).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "Extraction confidence" }).textContent,
  ).toContain("High support");
});
it("explains confidence as original support rather than a probability or approval", () => {
  render(<ReviewDetail detail={detail} {...callbacks} />);
  expect(
    screen.getByRole("region", { name: "Extraction confidence" }).textContent,
  ).toContain("High support");
  expect(
    screen.getByText("A complete date was stated in the source."),
  ).toBeTruthy();
  expect(screen.getByText(/not a measured probability/)).toBeTruthy();
});
it("high support remains blocked when current title is missing", () => {
  render(
    <ReviewDetail
      detail={{ ...detail, draft: { ...draft, title: "" } }}
      {...callbacks}
    />,
  );
  expect(screen.getByText("High support")).toBeTruthy();
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
it("low original support remains fixed after a manual correction becomes ready", async () => {
  const original = {
    ...draft,
    title: "",
    temporal: {
      kind: "unresolved" as const,
      text: "",
      timezone: "America/Chicago",
      timezoneProvenance: "assumed" as const,
    },
  };
  render(
    <ReviewDetail
      detail={{
        ...detail,
        candidate: {
          ...detail.candidate,
          draft: original,
          evidence: [],
          confidence: evaluateConfidence({ draft: original, evidence: [] }),
        },
      }}
      {...callbacks}
    />,
  );
  expect(screen.getByText("Low support")).toBeTruthy();
  expect(screen.getByText("Ready for approval")).toBeTruthy();
  expect(
    screen.getByText(/Current corrections differ from the original extraction/),
  ).toBeTruthy();
  await userEvent.clear(screen.getByLabelText("Title"));
  await userEvent.type(screen.getByLabelText("Title"), "Corrected Workshop");
  expect(screen.getByText("Low support")).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "Approve and add",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});
it("unknown evidence and raw stored exceptions never become user explanations", () => {
  render(
    <ReviewDetail
      detail={{
        ...detail,
        candidate: {
          ...detail.candidate,
          evidence: [{ code: "SQL internal secret exception" }],
          validationIssues: ["password=private internal exception"],
        },
      }}
      {...callbacks}
    />,
  );
  expect(screen.queryByText(/SQL internal|password=private/)).toBeNull();
  expect(
    screen.getByText("Additional extraction evidence was recorded."),
  ).toBeTruthy();
});
it("legacy confidence and unavailable source remain explicit", () => {
  render(
    <ReviewDetail
      detail={{
        ...detail,
        originalText: null,
        candidate: { ...detail.candidate, confidence: null },
      }}
      {...callbacks}
    />,
  );
  expect(screen.getByText("Not scored")).toBeTruthy();
  expect(screen.getByText(/legacy extraction/)).toBeTruthy();
  expect(screen.getByText("Original content expired or deleted.")).toBeTruthy();
});
it("original assumption is explained separately from a confirmed current timezone", () => {
  const original = {
    ...draft,
    temporal: {
      ...draft.temporal,
      timezoneProvenance: "assumed",
    } as Detail["draft"]["temporal"],
  };
  render(
    <ReviewDetail
      detail={{
        ...detail,
        candidate: { ...detail.candidate, draft: original },
      }}
      {...callbacks}
    />,
  );
  expect(
    screen.getByText(
      /Original timezone: America\/Chicago — assumed from settings/,
    ),
  ).toBeTruthy();
});
