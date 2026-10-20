import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
test.afterAll(() => db.$disconnect());
async function importMessage(
  page: import("@playwright/test").Page,
  subject: string,
) {
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page.getByLabel("Select " + subject).check();
  await page.getByRole("button", { name: "Import selected" }).click();
  await expect(page.getByRole("status")).toContainText("1 for review");
  await page.getByRole("button", { name: "Review queue", exact: true }).click();
  await page.getByRole("button", { name: "Open " + subject }).click();
}
async function confirmDuration(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Propose 60 minutes" }).click();
  await page.getByLabel("I confirm this proposed duration").check();
}
test("synthetic_provider_import_review_and_repeat_write", async ({ page }) => {
  await page.goto("/test/login");
  await importMessage(page, "Synthetic Workshop");
  await expect(
    page.getByRole("button", { name: "Approve and add" }),
  ).toBeDisabled();
  await confirmDuration(page);
  await page.getByRole("button", { name: "Approve and add" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Added to Google Calendar",
  );
  const id = await db.reviewItem.findFirst({
    where: { user: { email: "browser-fixture@example.test" }, status: "added" },
    orderBy: { createdAt: "desc" },
  });
  expect(id).not.toBeNull();
  const me = await page.request.get("/api/me");
  const response = await page.request.post(
    "/api/reviews/" + id!.id + "/calendar",
    {
      headers: {
        Origin: "http://127.0.0.1:4173",
        "x-csrf-token": (await me.json()).csrf,
      },
    },
  );
  expect(response.status()).toBe(200);
  expect((await response.json()).status).toBe("added");
  expect(
    await db.calendarEvent.count({ where: { reviewItemId: id!.id } }),
  ).toBe(1);
  await page.screenshot({
    path: "test-results/dashboard-review.png",
    fullPage: true,
  });
});
test("synthetic_ambiguous_message_requires_correction", async ({ page }) => {
  await page.goto("/test/login");
  await importMessage(page, "Synthetic Exam");
  await expect(
    page.getByRole("button", { name: "Approve and add" }),
  ).toBeDisabled();
  await page.getByLabel("Event type").selectOption("all_day");
  await page.getByLabel("Start", { exact: true }).fill("2026-10-19");
  await page.getByLabel("End date (exclusive)").fill("2026-10-20");
  await page.getByRole("button", { name: "Approve and add" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Added to Google Calendar",
  );
});
test("synthetic_lost_response_preserves_approval_and_reconciles", async ({
  page,
}) => {
  await page.goto("/test/login");
  await importMessage(page, "Synthetic Career Event");
  await confirmDuration(page);
  await page.getByRole("button", { name: "Approve and add" }).click();
  await expect(page.getByRole("status")).toContainText("Outcome unknown");
  await page.getByRole("button", { name: "Retry calendar write" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Added to Google Calendar",
  );
});
