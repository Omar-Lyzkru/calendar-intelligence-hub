import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
test.afterAll(() => db.$disconnect());
async function open(page: Page, subject: string) {
  await page.goto("/test/login");
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page.getByLabel("Select " + subject).check();
  await page.getByRole("button", { name: "Import selected" }).click();
  await expect(page.getByRole("status")).toContainText("1 for review");
  await page.getByRole("button", { name: "Review queue", exact: true }).click();
  await page.getByRole("button", { name: "Open " + subject }).click();
  await expect(
    page.getByRole("button", { name: "Approve and add" }),
  ).toBeDisabled();
}
async function record(subject: string) {
  return db.reviewItem.findFirstOrThrow({
    where: { detectedEvent: { message: { subject } } },
    orderBy: { createdAt: "desc" },
  });
}
test("date-only requires interpretation and inclusive range confirms all-day without midnight", async ({
  page,
}) => {
  const subject = "Synthetic Date-only Workshop";
  await open(page, subject);
  await page.screenshot({
    path: "test-results/phase2-date-only.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Save corrections" }).click();
  await expect(
    page.getByRole("button", { name: "Approve and add" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Confirm as all-day" }).click();
  await expect(page.getByLabel("End date (exclusive)")).toHaveValue(
    "2027-01-03",
  );
  await page.getByRole("button", { name: "Approve and add" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Added to Google Calendar",
  );
  const r = await record(subject);
  expect(r.approvedSnapshot).toMatchObject({
    temporal: {
      kind: "all_day",
      startDate: "2026-12-31",
      endExclusive: "2027-01-03",
    },
  });
  const csrf = (await (await page.request.get("/api/me")).json()).csrf;
  const response = await page.request.post(`/api/reviews/${r.id}/calendar`, {
    headers: { Origin: "http://127.0.0.1:4173", "x-csrf-token": csrf },
  });
  expect(response.status()).toBe(200);
  expect(await db.calendarEvent.count({ where: { reviewItemId: r.id } })).toBe(
    1,
  );
});
test("missing year and unsupported abbreviation need manual correction", async ({
  page,
}) => {
  const subject = "Synthetic Partial Meeting";
  await open(page, subject);
  await expect(page.getByText(/Partial date:/)).toContainText("year required");
  await page.screenshot({
    path: "test-results/phase2-unresolved.png",
    fullPage: true,
  });
  await page.getByLabel("Start", { exact: true }).fill("2026-10-20T14:30");
  await page.getByLabel("End", { exact: true }).fill("2026-10-20T15:15");
  await page.getByLabel("Timezone", { exact: true }).fill("");
  await page.getByLabel("Timezone", { exact: true }).fill("America/Chicago");
  await expect(page.getByText(/Timezone source:/)).toContainText(
    "confirmed by you",
  );
  await expect(page.getByLabel("Start occurrence")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/phase2-normal-time.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Approve and add" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Added to Google Calendar",
  );
  expect((await record(subject)).approvedSnapshot).toMatchObject({
    temporal: {
      kind: "timed",
      start: "2026-10-20T19:30:00.000Z",
      end: "2026-10-20T20:15:00.000Z",
      timezoneProvenance: "user_confirmed",
    },
  });
  await page
    .getByRole("button", { name: "Delete local source content" })
    .click();
  await expect(
    page.getByText("Original content expired or deleted."),
  ).toBeVisible();
});
test("fallback occurrence choices survive save and spring gap never approves", async ({
  page,
}) => {
  const subject = "Synthetic Fallback Meeting";
  await open(page, subject);
  await page.getByLabel("Start", { exact: true }).fill("2026-03-08T02:30");
  await page.getByLabel("End", { exact: true }).fill("2026-03-08T03:30");
  await expect(
    page.getByRole("button", { name: "Approve and add" }),
  ).toBeDisabled();
  await expect(page.getByLabel("Start occurrence")).toHaveCount(0);
  await page.getByLabel("Start", { exact: true }).fill("2026-11-01T01:30");
  await page.getByLabel("End", { exact: true }).fill("2026-11-01T01:45");
  await expect(
    page.getByRole("button", { name: "Approve and add" }),
  ).toBeDisabled();
  await page.getByLabel("Start occurrence").selectOption("earlier");
  await page.getByLabel("End occurrence").selectOption("later");
  await page.getByRole("button", { name: "Save corrections" }).click();
  await page.getByRole("button", { name: "Review queue", exact: true }).click();
  await page.getByRole("button", { name: "Open " + subject }).click();
  await expect(page.getByLabel("Start occurrence")).toHaveValue("earlier");
  await expect(page.getByLabel("End occurrence")).toHaveValue("later");
  await page.getByRole("button", { name: "Approve and add" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Added to Google Calendar",
  );
  expect((await record(subject)).approvedSnapshot).toMatchObject({
    temporal: {
      start: "2026-11-01T06:30:00.000Z",
      end: "2026-11-01T07:45:00.000Z",
    },
  });
});
test("incomplete timed interpretation preserves known dates and entered end across reopen", async ({
  page,
}) => {
  const subject = "Synthetic Date-only Workshop";
  await open(page, subject);
  await page.getByRole("button", { name: "Enter a specific time" }).click();
  await page.getByRole("button", { name: "Save corrections" }).click();
  await page.getByRole("button", { name: "Review queue", exact: true }).click();
  await page.getByRole("button", { name: "Open " + subject }).click();
  await expect(page.getByText(/Known date:/)).toContainText(
    "2026-12-31 through 2027-01-02",
  );
  await page.getByLabel("End", { exact: true }).fill("2027-01-02T15:15");
  await page.getByRole("button", { name: "Save corrections" }).click();
  await page.getByRole("button", { name: "Review queue", exact: true }).click();
  await page.getByRole("button", { name: "Open " + subject }).click();
  await expect(page.getByLabel("End", { exact: true })).toHaveValue(
    "2027-01-02T15:15",
  );
  await expect(page.getByLabel("Start", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Approve and add" }),
  ).toBeDisabled();
  expect(
    await db.calendarEvent.count({
      where: { reviewItemId: (await record(subject)).id },
    }),
  ).toBe(0);
});
