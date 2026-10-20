// @vitest-environment jsdom
import { it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageSelection } from "./MessageSelection.js";
import { deriveReviewState, evaluateDraft } from "@hub/contracts";
afterEach(cleanup);
it("reimported ignored candidate is not counted as awaiting review", async () => {
  const state = deriveReviewState("ignored", evaluateDraft({}), null);
  render(
    <MessageSelection
      page={{
        messages: [
          {
            id: "m",
            subject: "",
            sender: "fixture@example.test",
            snippet: "Exam",
          },
        ],
        nextPageToken: undefined,
      }}
      onNext={() => {}}
      onImport={async () => ({
        items: [{ externalId: "m", status: "review", reviewId: "r", state }],
      })}
    />,
  );
  await userEvent.click(screen.getByLabelText("Select Untitled message"));
  await userEvent.click(
    screen.getByRole("button", { name: "Import selected" }),
  );
  expect((await screen.findByRole("status")).textContent).toContain(
    "0 for review",
  );
  expect(screen.getByText(/Previously ignored/)).toBeTruthy();
});
it("unexpected import exceptions do not expose their text", async () => {
  render(
    <MessageSelection
      page={{
        messages: [
          {
            id: "m",
            subject: "",
            sender: "fixture@example.test",
            snippet: "Exam",
          },
        ],
        nextPageToken: undefined,
      }}
      onNext={() => {}}
      onImport={async () => {
        throw Error("PRIVATE-SENTINEL");
      }}
    />,
  );
  await userEvent.click(screen.getByLabelText("Select Untitled message"));
  await userEvent.click(
    screen.getByRole("button", { name: "Import selected" }),
  );
  expect((await screen.findByRole("alert")).textContent).not.toContain(
    "PRIVATE-SENTINEL",
  );
});

it("imports_only_selected_ids", async () => {
  let imported: string[] = [];
  render(
    <MessageSelection
      page={{
        messages: [
          {
            id: "one",
            subject: "Meeting",
            sender: "a@example.test",
            snippet: "First",
          },
          {
            id: "two",
            subject: "Newsletter",
            sender: "b@example.test",
            snippet: "Second",
          },
        ],
      }}
      onNext={() => {}}
      onImport={async (ids) => {
        imported = ids;
        return { items: [{ externalId: "one", status: "review" }] };
      }}
    />,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Import selected",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await userEvent.click(screen.getByLabelText("Select Meeting"));
  await userEvent.click(
    screen.getByRole("button", { name: "Import selected" }),
  );
  expect(imported).toEqual(["one"]);
  expect(
    await screen.findByText("1 for review · 0 no event · 0 failed"),
  ).toBeTruthy();
});
it("Outlook import failure displays safe retry delay without raw Graph identity", async () => {
  const user = userEvent.setup();
  render(
    <MessageSelection
      provider="outlook"
      page={{
        messages: [
          {
            id: "opaque-private-graph-id",
            subject: "Synthetic Outlook",
            sender: "",
            snippet: "",
          },
        ],
      }}
      onNext={() => {}}
      onImport={async () => ({
        items: [
          {
            externalId: "opaque-private-graph-id",
            status: "failed",
            processingFailure: {
              stage: "fetch",
              code: "microsoft_rate_limited",
              message: "Microsoft requested a pause.",
              retryAfterSeconds: 120,
              recovery: {
                action: "retry_import",
                canRetryNow: false,
                message: "Wait before retrying.",
              },
            },
          },
        ],
      })}
    />,
  );
  await user.click(screen.getByLabelText("Select Synthetic Outlook"));
  await user.click(screen.getByRole("button", { name: "Import selected" }));
  await screen.findByText(/120 seconds/);
  expect(screen.queryByText(/opaque-private-graph-id/)).toBeNull();
});
