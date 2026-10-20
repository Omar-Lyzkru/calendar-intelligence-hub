import { it, expect } from "vitest";
import { parseTimezones } from "./parseTimezones.js";
it.each([
  ["America/Chicago", "America/Chicago"],
  ["Central Time", "America/Chicago"],
  ["Eastern Time", "America/New_York"],
  ["UTC", "UTC"],
])("preserves explicit supported %s", (text, timezone) =>
  expect(parseTimezones(text, "subject", "America/Chicago")).toMatchObject({
    kind: "resolved",
    timezone,
    provenance: "explicit",
  }),
);
it.each([
  "CST",
  "IST",
  "BST",
  "CT",
  "CDT",
  "Central Time and Eastern Time",
  "2:30 PM CEST",
])("keeps zone %s unresolved", (text) =>
  expect(parseTimezones(text, "content", "America/Chicago").kind).toBe(
    "unresolved",
  ),
);
it("ignores timezone-like email address and assumes configured zone only absent evidence", () =>
  expect(
    parseTimezones("reply cst@example.test", "content", "America/Chicago"),
  ).toMatchObject({
    kind: "resolved",
    timezone: "America/Chicago",
    provenance: "assumed",
  }));
it.each(["Japan Standard Time", "aest", "British Summer Time"])(
  "unsupported label preserves original evidence: %s",
  (label) => {
    const result = parseTimezones(
      `2 PM to 3 PM ${label}`,
      "subject",
      "America/Chicago",
    );
    expect(result.kind).toBe("unresolved");
    expect(
      result.evidence.some((e) => e.text === label && e.origin === "subject"),
    ).toBe(true);
  },
);

it("numeric offset shorthand cannot resolve a lowercase UTC name", () => {
  expect(
    parseTimezones("2 PM to 3 PM utc+9", "subject", "America/Chicago").kind,
  ).toBe("unresolved");
});
