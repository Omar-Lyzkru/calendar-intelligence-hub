import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
test.afterAll(() => db.$disconnect());
test("category correction persists, original evidence stays fixed and approved replay stays one write", async ({
  page,
}) => {
  await page.goto("/test/login");
  const select = async () => {
    await page.getByRole("button", { name: "Messages", exact: true }).click();
    await page.getByLabel("Select Synthetic Workshop").check();
    await page.getByRole("button", { name: "Import selected" }).click();
    await expect(page.getByRole("status")).toBeVisible();
  };
  const open = async () => {
    await page
      .getByRole("button", { name: "Review queue", exact: true })
      .click();
    await page.getByRole("button", { name: "Open Synthetic Workshop" }).click();
  };
  await select();
  await page.getByRole("button", { name: "Review queue", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "Hackathon / workshop", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open Synthetic Workshop" }).click();
  await expect(page.getByLabel("Category", { exact: true })).toHaveValue(
    "hackathon_workshop",
  );
  await page.getByLabel("Category", { exact: true }).selectOption("career");
  await page.getByRole("button", { name: "Propose 60 minutes" }).click();
  await page.getByLabel("I confirm this proposed duration").check();
  await page.getByRole("button", { name: "Save corrections" }).click();
  await page.getByRole("button", { name: "Review queue", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "Career event", exact: true }),
  ).toBeVisible();
  await open();
  await expect(page.getByLabel("Category", { exact: true })).toHaveValue(
    "career",
  );
  await expect(
    page.getByText("Suggested category: Hackathon / workshop"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve and add" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Added to Google Calendar",
  );
  const me = await (await page.request.get("/api/me")).json();
  const row = await db.reviewItem.findFirstOrThrow({
    where: { userId: me.user.id },
  });
  expect((row.approvedSnapshot as any).eventCategory).toBe("career");
  await open();
  await expect(page.getByLabel("Category", { exact: true })).toBeDisabled();
  await select();
  await expect(page.getByRole("status")).toContainText("0 for review");
  expect(
    await db.calendarEvent.count({ where: { reviewItemId: row.id } }),
  ).toBe(1);
  expect(
    (await db.reviewItem.findUniqueOrThrow({ where: { id: row.id } }))
      .approvedSnapshot,
  ).toEqual(row.approvedSnapshot);
});
