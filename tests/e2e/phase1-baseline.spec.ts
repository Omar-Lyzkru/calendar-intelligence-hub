import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
test.afterAll(() => db.$disconnect());
test("observed_ambiguous_candidate_blocks_browser_and_direct_approval", async ({
  page,
}) => {
  await page.goto("/test/login");
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page.getByLabel("Select Synthetic Exam").check();
  await page.getByRole("button", { name: "Import selected" }).click();
  await expect(page.getByRole("status")).toContainText("1 for review");
  await page.getByRole("button", { name: "Review queue", exact: true }).click();
  await page.getByRole("button", { name: "Open Synthetic Exam" }).click();
  await expect(
    page.getByRole("button", { name: "Approve and add" }),
  ).toBeDisabled();
  const reviews = await page.request.get("/api/reviews");
  const item = (await reviews.json()).items.find(
    (r: any) => r.title === "Synthetic Exam",
  );
  const detail = await page.request.get("/api/reviews/" + item.id),
    me = await page.request.get("/api/me");
  const response = await page.request.post(
    "/api/reviews/" + item.id + "/approve",
    {
      headers: {
        Origin: "http://127.0.0.1:4173",
        "x-csrf-token": (await me.json()).csrf,
      },
      data: { expectedRevision: (await detail.json()).revision },
    },
  );
  expect(response.status()).toBe(422);
  const after = await db.reviewItem.findUniqueOrThrow({
    where: { id: item.id },
  });
  expect(after.status).toBe("needs_review");
  expect(after.approvedSnapshot).toBeNull();
  expect(
    await db.calendarEvent.count({ where: { reviewItemId: item.id } }),
  ).toBe(0);
  await page.screenshot({
    path: "test-results/phase1-ambiguous-block.png",
    fullPage: true,
  });
});
