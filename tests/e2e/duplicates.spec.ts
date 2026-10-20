import { test, expect, type Page } from "@playwright/test";
async function open(page: Page, subject: string) {
  await page.goto("/test/login");
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page.getByLabel("Select " + subject).check();
  await page.getByRole("button", { name: "Import selected" }).click();
  await expect(page.getByRole("status")).toContainText("1 for review");
  await page.getByRole("button", { name: "Review queue", exact: true }).click();
  await page.getByRole("button", { name: "Open " + subject }).click();
}
test("manual live-source match pauses writing; explicit advisory override writes once", async ({
  page,
}) => {
  let writes = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/calendar")) writes++;
  });
  await open(page, "CodeRED Orion");
  await page
    .getByRole("button", { name: "Approve and add", exact: true })
    .click();
  await expect(
    page.getByText("CodeRED Orion Hackathon", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Similar title", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve and add anyway" }),
  ).toBeEnabled();
  expect(writes).toBe(0);
  await page.getByRole("button", { name: "Approve and add anyway" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Added to Google Calendar",
  );
  expect(writes).toBe(1);
  await page.getByRole("button", { name: "Check possible duplicates" }).click();
  await expect(
    page.getByRole("heading", { name: "Exact identity — existing protection" }),
  ).toBeVisible();
  expect(writes).toBe(1);
  await page.screenshot({
    path: "test-results/phase2c-protected-receipt.png",
    fullPage: true,
  });
});
test("editing after matches invalidates the warning and checks the corrected draft", async ({
  page,
}) => {
  await open(page, "CodeRED Orion");
  await page.getByRole("button", { name: "Check possible duplicates" }).click();
  await expect(
    page.getByText("CodeRED Orion Hackathon", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Title", { exact: true }).fill("Different commitment");
  await expect(
    page.getByRole("button", { name: "Approve and add anyway" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Approve and add", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Scheduling conflicts" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve and add anyway" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Added to Google Calendar",
  );
});
test("failed live lookup with no matches is incomplete and permits informed manual continuation", async ({
  page,
}) => {
  let writes = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/calendar")) writes++;
  });
  await open(page, "Synthetic Lookup Unavailable");
  await page
    .getByRole("button", { name: "Approve and add", exact: true })
    .click();
  await expect(page.getByText(/Check incomplete/)).toBeVisible();
  await expect(page.getByText(/Calendar lookup unavailable/)).toBeVisible();
  await expect(
    page.getByText("No possible matches in checked sources."),
  ).toHaveCount(0);
  expect(writes).toBe(0);
  await page.getByRole("button", { name: "Approve and add anyway" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Added to Google Calendar",
  );
  expect(writes).toBe(1);
});
