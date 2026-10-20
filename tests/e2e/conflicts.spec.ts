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
test("different-title overlap pauses writing until an explicit override", async ({
  page,
}) => {
  let writes = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/calendar")) writes++;
  });
  await open(page, "Synthetic Conflict Meeting");
  await page
    .getByRole("button", { name: "Approve and add", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Scheduling conflicts" }),
  ).toBeVisible();
  await expect(
    page.getByText("CodeRED Orion Hackathon", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/^Overlap:.*60 minutes/)).toBeVisible();
  expect(writes).toBe(0);
  await page.screenshot({
    path: "test-results/phase2d-timed-conflict.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Approve and add anyway" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Added to Google Calendar",
  );
  expect(writes).toBe(1);
});
test("correction to an adjacent interval invalidates conflicts and permits a clean new check", async ({
  page,
}) => {
  await open(page, "Synthetic Conflict Meeting");
  await page.getByRole("button", { name: "Check possible duplicates" }).click();
  await expect(
    page.getByRole("heading", { name: "Scheduling conflicts" }),
  ).toBeVisible();
  await page.getByLabel("End", { exact: true }).fill("2026-10-10T12:00");
  await page.getByLabel("Start", { exact: true }).fill("2026-10-10T11:00");
  await expect(
    page.getByRole("heading", { name: "Scheduling conflicts" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Approve and add", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Added to Google Calendar",
  );
});
test("unconfirmed dates skip conflicts; explicit all-day confirmation reveals an all-day advisory", async ({
  page,
}) => {
  await open(page, "Synthetic All-day Conflict");
  await expect(
    page.getByRole("button", { name: "Approve and add", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Check possible duplicates" }).click();
  await expect(
    page.getByText(
      /^Local approved commitments:.*Confirm all-day or supply complete start and end/,
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm as all-day" }).click();
  await page
    .getByRole("button", { name: "Approve and add", exact: true })
    .click();
  await expect(
    page.getByText("All-day overlap advisory", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve and add anyway" }),
  ).toBeEnabled();
  await page.screenshot({
    path: "test-results/phase2d-all-day-conflict.png",
    fullPage: true,
  });
});
test("unknown busy suitability has independent incomplete coverage, not a clean result", async ({
  page,
}) => {
  await open(page, "Synthetic Conflict Lookup Partial");
  await page
    .getByRole("button", { name: "Approve and add", exact: true })
    .click();
  await expect(page.getByText(/Conflict lookup incomplete/)).toBeVisible();
  await expect(
    page.getByText("No overlapping commitments in checked sources."),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Approve and add anyway" }),
  ).toBeEnabled();
});
