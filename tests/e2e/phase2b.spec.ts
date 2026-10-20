import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
test.afterAll(() => db.$disconnect());
async function selected(page: Page, subject = "Untitled message") {
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page.getByLabel("Select " + subject).check();
  await page.getByRole("button", { name: "Import selected" }).click();
  await expect(page.getByRole("status")).toBeVisible();
}
async function me(page: Page) {
  return await (await page.request.get("/api/me")).json();
}
async function record(page: Page) {
  const current = await me(page);
  return db.reviewItem.findFirstOrThrow({
    where: { userId: current.user.id },
    orderBy: { createdAt: "desc" },
  });
}
async function open(page: Page) {
  await page.getByRole("button", { name: "Review queue", exact: true }).click();
  await page.getByRole("button", { name: "Open Untitled candidate" }).click();
}
test("blank title/date-only blockers survive save; direct approval cannot write; explicit correction succeeds", async ({
  page,
}) => {
  await page.goto("/test/login");
  await selected(page);
  await open(page);
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("");
  await expect(
    page.locator('[data-blocker-code="title_required"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-blocker-code="date_only_unconfirmed"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve and add" }),
  ).toBeDisabled();
  await page.screenshot({
    path: "test-results/phase2b-blockers.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Save corrections" }).click();
  await open(page);
  const r = await record(page);
  expect((r.draft as any).title).toBe("");
  const auth = await me(page);
  const blocked = await page.request.post(`/api/reviews/${r.id}/approve`, {
    headers: { Origin: "http://127.0.0.1:4173", "x-csrf-token": auth.csrf },
    data: { expectedRevision: r.revision },
  });
  expect(blocked.status()).toBe(422);
  expect((await blocked.json()).error.blockers.map((b: any) => b.code)).toEqual(
    expect.arrayContaining(["title_required", "date_only_unconfirmed"]),
  );
  expect(await db.calendarEvent.count({ where: { reviewItemId: r.id } })).toBe(
    0,
  );
  await page
    .getByLabel("Title", { exact: true })
    .fill("Synthetic Corrected Workshop");
  await page.getByRole("button", { name: "Confirm as all-day" }).click();
  await expect(page.getByLabel("Location (optional)")).toHaveValue("");
  await expect(page.getByLabel("Description (optional)")).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Approve and add" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Approve and add" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Added to Google Calendar",
  );
  expect((await record(page)).approvedSnapshot).toMatchObject({
    title: "Synthetic Corrected Workshop",
    location: null,
    description: null,
    temporal: {
      kind: "all_day",
      startDate: "2026-10-20",
      endExclusive: "2026-10-21",
    },
  });
  await selected(page);
  await expect(page.getByRole("status")).toContainText("0 for review");
  expect(await db.calendarEvent.count({ where: { reviewItemId: r.id } })).toBe(
    1,
  );
  expect((await record(page)).id).toBe(r.id);
});
test("ignore and repeated import preserve decision and candidate identity", async ({
  page,
}) => {
  await page.goto("/test/login");
  await selected(page);
  await open(page);
  const r = await record(page);
  await page.getByRole("button", { name: "Ignore", exact: true }).click();
  await expect(page.getByText("ignored", { exact: true })).toBeVisible();
  await selected(page);
  await expect(page.getByRole("status")).toContainText("0 for review");
  await expect(page.getByText(/Previously ignored/)).toBeVisible();
  const after = await record(page);
  expect(after.id).toBe(r.id);
  expect(after.status).toBe("ignored");
  expect(await db.calendarEvent.count({ where: { reviewItemId: r.id } })).toBe(
    0,
  );
});
test("technical normalization failure has safe stage guidance; ambiguity stays normal review", async ({
  page,
}) => {
  await page.goto("/test/login");
  await selected(page, "Synthetic Malformed Message");
  await expect(page.getByRole("status")).toContainText("1 failed");
  await expect(
    page.getByText(/message response could not be read safely/),
  ).toBeVisible();
  const auth = await me(page);
  const attempts = await db.processingAttempt.findMany({
    where: { connection: { userId: auth.user.id } },
  });
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({
    stage: "normalize",
    outcome: "failed",
    errorCode: "invalid_provider_payload",
  });
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByText("Message normalization failed")).toBeVisible();
  await selected(page, "Synthetic Exam");
  await expect(page.getByRole("status")).toContainText("1 for review");
  await page.getByRole("button", { name: "Review queue", exact: true }).click();
  await page.getByRole("button", { name: "Open Synthetic Exam" }).click();
  await expect(
    page.getByRole("button", { name: "Approve and add" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("list", { name: "Approval blockers" }),
  ).toBeVisible();
});
