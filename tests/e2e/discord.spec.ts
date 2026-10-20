import { test, expect } from "@playwright/test";
test("synthetic Discord automatically reaches shared review, reconnect edit requires confirmation and disconnect preserves history", async ({
  page,
}) => {
  await page.goto("/test/login");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page
    .getByRole("button", { name: "Connect Discord", exact: true })
    .click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page.getByLabel("Message source").selectOption("discord");
  await expect(
    page.getByRole("heading", { name: "Discord announcements" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Import selected" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Review Untitled candidate" }).click();
  await expect(page.getByText(/Source: Discord. Received:/)).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Extraction confidence" }),
  ).toBeVisible();
  await expect(page.getByText(/Suggested category: Hackathon/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve and add", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Discord workshop confirmed");
  await page.getByRole("button", { name: "Save corrections" }).click();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page
    .getByRole("button", { name: "Reconnect Discord", exact: true })
    .click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await page.getByRole("button", { name: "Review queue", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Open Discord workshop confirmed",
      exact: true,
    })
    .click();
  await expect(page.getByText(/announcement changed in Discord/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve and add", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Discord corrected decision");
  await page.getByLabel(/I checked the latest announcement/).check();
  await page
    .getByRole("button", { name: "Confirm source decision", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Confirm source decision", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Discord corrected decision",
  );
  await expect(
    page.getByRole("button", { name: "Approve and add", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Check possible duplicates" }).click();
  await expect(
    page.getByRole("heading", { name: "Calendar conflict check" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page
    .getByRole("button", { name: "Disconnect Discord", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Connect Discord", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Review queue", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Open Discord corrected decision",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(
    page.getByText("Discord source decision confirmed", { exact: true }),
  ).toBeVisible();
});
