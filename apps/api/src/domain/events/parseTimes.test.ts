import { it, expect } from "vitest";
import { parseTimes } from "./parseTimes.js";
it.each([
  ["2:30pm", ["14:30"]],
  ["14:30", ["14:30"]],
  ["2:30–4:00 PM", ["14:30", "16:00"]],
  ["11:30 PM–12:15 AM", ["23:30", "00:15"]],
])("parses explicit clock %s", (text, clocks) =>
  expect(parseTimes(text, "content").tokens.map((t) => t.clock)).toEqual(
    clocks,
  ),
);
it("does not infer meridiem across a half-day or parse URL clock fragments", () => {
  expect(parseTimes("11–1 PM", "content").issues.length).toBeGreaterThan(0);
  expect(parseTimes("https://example.test/14:30", "content").tokens).toEqual(
    [],
  );
});
it("connected twenty-four-hour range supports a word connector", () => {
  expect(
    parseTimes("14:30 to 16:00", "content").tokens.map((t) => t.clock),
  ).toEqual(["14:30", "16:00"]);
});
