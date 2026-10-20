import { test, expect } from "@playwright/test";
async function importAndOpen(
  page: import("@playwright/test").Page,
  title: string,
) {
  await page.goto("/test/login");
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page.getByLabel("Select " + title).check();
  await page.getByRole("button", { name: "Import selected" }).click();
  await expect(page.getByRole("status")).toBeVisible();
  await page.getByRole("button", { name: "Review queue", exact: true }).click();
  await page.getByRole("button", { name: "Open " + title }).click();
}
test("high support explains facts while failed Calendar lookup remains unavailable", async ({
  page,
}) => {
  await importAndOpen(page, "Synthetic Lookup Unavailable");
  const confidence = page.getByRole("region", {
    name: "Extraction confidence",
  });
  await expect(confidence).toContainText("High support");
  await expect(confidence).toContainText("not a measured probability");
  await expect(page.getByText(/Source: Gmail. Received:/)).toBeVisible();
  await page.getByRole("button", { name: "Check possible duplicates" }).click();
  await expect(page.getByText(/unavailable/i).first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve and add anyway" }),
  ).toBeVisible();
  await expect(confidence).toContainText("High support");
});
test("low original support survives manual correction and explicit synthetic approval", async ({
  page,
}) => {
  await importAndOpen(page, "Synthetic Exam");
  await expect(
    page.getByRole("region", { name: "Extraction confidence" }),
  ).toContainText("Low support");
  await expect(
    page.getByRole("button", { name: "Approve and add", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Event type").selectOption("all_day");
  await page.getByLabel("Start", { exact: true }).fill("2026-11-12");
  await page.getByLabel("End date (exclusive)").fill("2026-11-13");
  await expect(
    page.getByText("Ready for approval", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Current corrections differ from the original extraction/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save corrections" }).click();
  await expect(
    page.getByRole("region", { name: "Extraction confidence" }),
  ).toContainText("Low support");
  await page
    .getByRole("button", { name: "Approve and add", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Added to Google Calendar",
  );
  await page.screenshot({
    path: "test-results/phase2-intelligence-synthetic.png",
    fullPage: true,
  });
});
