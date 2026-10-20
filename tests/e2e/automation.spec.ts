import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
test.afterAll(() => db.$disconnect());
async function enable(page: Page) {
  await page.getByRole("button", { name: "Automation", exact: true }).click();
  await page.getByRole("button", { name: "Add rule" }).click();
  await page.getByLabel("Rule 1 action").selectOption("auto");
  await page.getByLabel("Enable automatic Calendar actions").check();
  await page.getByRole("button", { name: "Save automation settings" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Automation settings saved",
  );
}
async function importSelected(page: Page, subject: string) {
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page.getByLabel("Select " + subject).check();
  await page.getByRole("button", { name: "Import selected" }).click();
  await expect(page.getByRole("status")).toContainText("1 for review");
}
test("opt-in rule automatically adds once, repeated checks stay one and disabling preserves manual Review", async ({
  page,
}) => {
  const failures: string[] = [];
  page.on("response", (r) => {
    if (r.status() >= 500)
      failures.push(
        r.request().method() +
          " " +
          new URL(r.url()).pathname.replace(/[a-f0-9-]{36}/g, ":id"),
      );
  });
  await page.goto("/test/login");
  await expect(
    page.getByRole("heading", { name: "Activity", exact: true }),
  ).toBeVisible();
  await enable(page);
  await importSelected(page, "Automatic Exam");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  await expect(
    page.getByText("Added to Calendar", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page.screenshot({
    path: "test-results/phase5-activity.png",
    fullPage: true,
  });
  const me = await (await page.request.get("/api/me")).json();
  expect(
    await db.calendarEvent.count({ where: { review: { userId: me.user.id } } }),
  ).toBe(1);
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  await page.getByRole("button", { name: "Refresh activity" }).click();
  expect(
    await db.calendarEvent.count({ where: { review: { userId: me.user.id } } }),
  ).toBe(1);
  await page.getByRole("button", { name: "Automation", exact: true }).click();
  await page.getByLabel("Enable automatic Calendar actions").uncheck();
  await page.getByRole("button", { name: "Save automation settings" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Automation settings saved",
  );
  await importSelected(page, "Automatic Second Exam");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  await expect(
    page.getByText(/Automatic Calendar actions are off/),
  ).toBeVisible();
  expect(
    await db.calendarEvent.count({ where: { review: { userId: me.user.id } } }),
  ).toBe(1);
  await page.getByRole("button", { name: "Review queue", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Automatic Second Exam", exact: true })
    .click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Automatic Second Exam",
  );
  expect(failures).toEqual([]);
});
test("activity separates focused questions, skips and provider problems without source text", async ({
  page,
}) => {
  await page.goto("/test/login?automation=attention");
  await expect(
    page.getByRole("heading", { name: "Needs you", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Skipped", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Problems", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Required duplicate or conflict checks are incomplete/),
  ).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain(
    "PRIVATE_AUTOMATION_SENTINEL",
  );
  await page.screenshot({
    path: "test-results/phase5-attention.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Use all day", exact: true }).click();
  await expect(
    page.getByText("Added to Calendar", { exact: true }),
  ).toBeVisible();
  const me = await (await page.request.get("/api/me")).json();
  expect(
    await db.calendarEvent.count({ where: { review: { userId: me.user.id } } }),
  ).toBe(1);
});
test("Ask rule uses a focused one-time approval and leaves the rule restricted", async ({
  page,
}) => {
  await page.goto("/test/login");
  await page.getByRole("button", { name: "Automation", exact: true }).click();
  await page.getByRole("button", { name: "Add rule" }).click();
  await page.getByLabel("Enable automatic Calendar actions").check();
  await page.getByRole("button", { name: "Save automation settings" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Automation settings saved",
  );
  await importSelected(page, "Automatic Exam");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Add this event once", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  const me = await (await page.request.get("/api/me")).json();
  expect(
    await db.calendarEvent.count({ where: { review: { userId: me.user.id } } }),
  ).toBe(0);
  await page
    .getByRole("button", { name: "Add this event once", exact: true })
    .click();
  await expect(
    page.getByText("Added to Calendar", { exact: true }),
  ).toBeVisible();
  expect(
    (await (await page.request.get("/api/automation/policy")).json()).rules[0]
      .action,
  ).toBe("ask");
  expect(
    await db.calendarEvent.count({ where: { review: { userId: me.user.id } } }),
  ).toBe(1);
});
