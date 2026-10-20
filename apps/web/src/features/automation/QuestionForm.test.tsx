// @vitest-environment jsdom
import { it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuestionForm } from "./QuestionForm.js";
afterEach(cleanup);
const question: any = {
  id: "80000000-0000-4000-8000-000000000001",
  kind: "title",
  reviewRevision: 2,
  prompt: "What should this commitment be called?",
};
it("title question asks no optional event information", async () => {
  let answer: any;
  render(
    <QuestionForm
      question={question}
      title="Untitled candidate"
      onAnswer={async (a) => {
        answer = a;
      }}
      onSettings={() => {}}
    />,
  );
  expect(screen.queryByLabelText("Location")).toBeNull();
  expect(screen.queryByLabelText("Description")).toBeNull();
  await userEvent.type(screen.getByLabelText("Event title"), "My exam");
  await userEvent.click(screen.getByRole("button", { name: "Save answer" }));
  expect(answer).toEqual({ kind: "title", value: "My exam" });
});
it("failed answer preserves entered facts and hides raw failure diagnostics", async () => {
  render(
    <QuestionForm
      question={question}
      title="Untitled candidate"
      onAnswer={async () => {
        throw Error("PRIVATE_FAILURE_SENTINEL");
      }}
      onSettings={() => {}}
    />,
  );
  await userEvent.type(screen.getByLabelText("Event title"), "My exam");
  await userEvent.click(screen.getByRole("button", { name: "Save answer" }));
  expect((screen.getByLabelText("Event title") as HTMLInputElement).value).toBe(
    "My exam",
  );
  expect((await screen.findByRole("alert")).textContent).not.toContain(
    "PRIVATE_FAILURE_SENTINEL",
  );
});
it("a nonexistent DST time never submits an invented instant", async () => {
  let count = 0;
  render(
    <QuestionForm
      question={{ ...question, kind: "time", prompt: "Choose times" }}
      title="Exam"
      onAnswer={async () => {
        count++;
      }}
      onSettings={() => {}}
    />,
  );
  await userEvent.type(
    screen.getByLabelText("Start date and time"),
    "2026-03-08T02:30",
  );
  await userEvent.type(
    screen.getByLabelText("End date and time"),
    "2026-03-08T04:00",
  );
  await userEvent.clear(screen.getByLabelText("Timezone"));
  await userEvent.type(screen.getByLabelText("Timezone"), "America/Chicago");
  await userEvent.click(screen.getByRole("button", { name: "Save answer" }));
  expect(count).toBe(0);
  expect(screen.getByRole("alert").textContent).toMatch(/does not exist/);
});
it("advisory confirmation displays commitment facts as text and requires explicit continuation", async () => {
  let answer: any;
  render(
    <QuestionForm
      question={{
        ...question,
        kind: "duplicate",
        prompt: "Separate commitment?",
        matches: [{ title: "<script>private()</script>", temporal: null }],
      }}
      title="Exam"
      onAnswer={async (a) => {
        answer = a;
      }}
      onSettings={() => {}}
    />,
  );
  expect(screen.getByText("<script>private()</script>")).toBeTruthy();
  expect(document.querySelector("script")).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Add as a separate commitment" }),
  );
  expect(answer).toEqual({ kind: "confirm", value: true });
});
it("Ask-rule confirmation clearly authorizes only this event", async () => {
  let answer: any;
  render(
    <QuestionForm
      question={{
        ...question,
        kind: "facts",
        oneTimeApproval: true,
        prompt: "Add this event once?",
      }}
      title="Exam"
      onAnswer={async (a) => {
        answer = a;
      }}
      onSettings={() => {}}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Add this event once" }),
  );
  expect(answer).toEqual({ kind: "confirm", value: true });
});
it("all-day interpretation shows the actual date before asking for confirmation", () => {
  render(
    <QuestionForm
      question={{
        ...question,
        kind: "all_day",
        prompt: "Should this be all day?",
        suggestedTemporal: {
          kind: "date_only",
          startDate: "2026-10-23",
          endDateInclusive: null,
        },
      }}
      title="Exam"
      onAnswer={async () => {}}
      onSettings={() => {}}
    />,
  );
  expect(screen.getByText(/Date only.*2026-10-23/)).toBeTruthy();
});
