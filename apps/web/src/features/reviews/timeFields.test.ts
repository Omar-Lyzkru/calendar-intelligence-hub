import { it, expect } from "vitest";
import {
  proposedDuration,
  temporalFromFields,
  type TimeFields,
} from "./timeFields.js";
it("sixty_minutes_means_elapsed_time_across_fall_back", () => {
  const start: TimeFields = {
    kind: "timed",
    start: "2026-11-01T01:30",
    end: "",
    timezone: "America/Chicago",
    offset: "earlier",
  };
  const proposal = proposedDuration(start);
  expect(proposal.end).toBe("2026-11-01T01:30");
  expect(proposal.endOffset).toBe("later");
  expect(temporalFromFields({ ...start, ...proposal })).toMatchObject({
    start: "2026-11-01T06:30:00.000Z",
    end: "2026-11-01T07:30:00.000Z",
  });
});
it("sixty_minutes_means_elapsed_time_across_spring_forward", () => {
  const start: TimeFields = {
    kind: "timed",
    start: "2026-03-08T01:30",
    end: "",
    timezone: "America/Chicago",
    offset: "reject",
  };
  const proposal = proposedDuration(start);
  expect(proposal.end).toBe("2026-03-08T03:30");
  expect(temporalFromFields({ ...start, ...proposal })).toMatchObject({
    start: "2026-03-08T07:30:00.000Z",
    end: "2026-03-08T08:30:00.000Z",
  });
});

import { EventDraftSchema } from "@hub/contracts";
import { initialTime, interpretDateOnly } from "./timeFields.js";
const base = {
  title: "Workshop",
  location: null,
  description: null,
  category: "event" as const,
};
it("date-only preserves dates until explicit interpretation", () => {
  const f = initialTime(
    {
      ...base,
      temporal: {
        kind: "date_only",
        startDate: "2026-12-31",
        endDateInclusive: "2027-01-02",
      },
    },
    "America/New_York",
  );
  expect(temporalFromFields(f)).toEqual({
    kind: "date_only",
    startDate: "2026-12-31",
    endDateInclusive: "2027-01-02",
  });
  expect(interpretDateOnly(f, "all_day")).toMatchObject({
    kind: "all_day",
    start: "2026-12-31",
    end: "2027-01-03",
  });
  expect(interpretDateOnly(f, "timed")).toMatchObject({
    kind: "timed",
    start: "",
    end: "",
    knownStartDate: "2026-12-31",
  });
});
it("saved repeated endpoints retain independent exact instants", () => {
  const t = {
    kind: "timed" as const,
    start: "2026-11-01T06:30:00.000Z",
    end: "2026-11-01T07:45:00.000Z",
    timezone: "America/Chicago",
    timezoneProvenance: "explicit" as const,
  };
  const f = initialTime({ ...base, temporal: t });
  expect(f.offset).toBe("earlier");
  expect(f.endOffset).toBe("later");
  expect(temporalFromFields(f)).toEqual(t);
});
it("gap remains invalid for earlier and later and incomplete draft can save", () => {
  const f: TimeFields = {
    kind: "timed",
    start: "2026-03-08T02:30",
    end: "",
    timezone: "America/Chicago",
    offset: "earlier",
  };
  expect(() => temporalFromFields(f)).toThrow();
  expect(() => temporalFromFields({ ...f, offset: "later" })).toThrow();
  expect(temporalFromFields({ ...f, start: "" })).toMatchObject({
    kind: "unresolved",
  });
});
it("end entered before start survives an incomplete save and reopen", () => {
  const fields: TimeFields = {
    kind: "timed",
    start: "",
    end: "2026-10-20T15:15",
    timezone: "America/Chicago",
    offset: "reject",
  };
  const temporal = temporalFromFields(fields);
  expect(initialTime(EventDraftSchema.parse({ ...base, temporal })).end).toBe(
    fields.end,
  );
});
it("timed interpretation preserves known date range through incomplete save", () => {
  const f = interpretDateOnly(
    initialTime({
      ...base,
      temporal: {
        kind: "date_only",
        startDate: "2026-12-31",
        endDateInclusive: "2027-01-02",
      },
    }),
    "timed",
  );
  const reopened = initialTime({ ...base, temporal: temporalFromFields(f) });
  expect(reopened.knownStartDate).toBe("2026-12-31");
  expect(reopened.knownEndDate).toBe("2027-01-02");
  expect(reopened.start).toBe("");
});
it("sixty-minute proposal retains exact fractional elapsed time", () => {
  const f: TimeFields = {
    kind: "timed",
    start: "2026-10-20T14:00:12.345",
    end: "",
    timezone: "America/Chicago",
    offset: "reject",
  };
  expect(proposedDuration(f).end).toBe("2026-10-20T15:00:12.345");
});

it("gap conversion transports the Phase2A issue code instead of requiring message parsing", () => {
  try {
    temporalFromFields({
      kind: "timed",
      start: "2026-03-08T02:30",
      end: "",
      timezone: "America/Chicago",
      offset: "reject",
    });
    throw Error("unexpected success");
  } catch (error) {
    expect(error).toMatchObject({
      issues: [{ code: "nonexistent_time", field: "temporal.start" }],
    });
  }
});
it("unresolved extraction codes survive an incomplete save and disappear only with a complete correction", () => {
  const t = {
    kind: "unresolved" as const,
    text: "",
    timezone: "America/Chicago",
    partial: { month: 10, day: 20 },
    issueCodes: ["unresolved_timezone"],
  };
  const f = initialTime({ ...base, temporal: t });
  expect(temporalFromFields(f)).toMatchObject({
    issueCodes: ["unresolved_timezone"],
  });
});
