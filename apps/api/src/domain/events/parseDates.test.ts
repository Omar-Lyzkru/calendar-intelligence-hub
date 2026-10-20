import { it, expect } from "vitest";
import { parseDates } from "./parseDates.js";
it.each([
  ["October 20, 2026", "2026-10-20"],
  ["Oct 20, 2026", "2026-10-20"],
  ["2026-10-20", "2026-10-20"],
  ["10/20/2026", "2026-10-20"],
  ["20/10/2026", "2026-10-20"],
  ["03/03/2026", "2026-03-03"],
  ["February 29, 2028", "2028-02-29"],
])("parses unique complete %s", (text, date) =>
  expect(parseDates(text, "subject")[0].completeDate).toBe(date),
);
it.each([
  "03/04/2026",
  "10/08/2026",
  "13/40/2026",
  "February 30, 2026",
  "February 29, 2026",
  "Friday, October 20, 2026",
  "10/20/26",
])("keeps invalid or ambiguous date %s unresolved", (text) => {
  const token = parseDates(text, "content")[0];
  expect(token.completeDate).toBeUndefined();
  expect(token.issues.length).toBeGreaterThan(0);
});
it("preserves missing-year evidence without inventing a year", () => {
  const token = parseDates("Tuesday, October 20", "subject")[0];
  expect(token.partial).toMatchObject({ month: 10, day: 20, weekday: 2 });
  expect(token.partial).not.toHaveProperty("year");
  expect(token.completeDate).toBeUndefined();
  expect(token.origin).toBe("subject");
  expect(token.text).toBe("Tuesday, October 20");
});
