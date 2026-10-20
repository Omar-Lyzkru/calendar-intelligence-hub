import { test, expect, type Page } from "@playwright/test";
for (const outcome of ["access_denied", "unauthorized_client"]) {
  test(`synthetic Microsoft ${outcome} returns readable guidance and keeps Gmail/reviews available`, async ({
    page,
  }) => {
    await page.goto("/test/login?microsoft=" + outcome);
    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Connect Outlook", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      outcome === "access_denied"
        ? "Microsoft access was not granted"
        : "school’s app-consent policy",
    );
    await expect(page).toHaveURL("/");
    await expect(
      page.getByRole("heading", { name: "Connections", exact: true }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText(
      "synthetic-private-diagnostic",
    );
    await page.getByRole("button", { name: "Messages", exact: true }).click();
    await expect(
      page.getByLabel("Select CodeRED Orion", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Review queue", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Your event candidates" }),
    ).toBeVisible();
  });
}
async function connect(page: Page) {
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page
    .getByRole("button", { name: "Connect Outlook", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Review queue", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page.getByLabel("Message source").selectOption("outlook");
}
test("synthetic Outlook code flow imports HTML into complete shared review and protected Google write", async ({
  page,
}) => {
  await page.goto("/test/login");
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page.getByLabel("Select CodeRED Orion").check();
  await page.getByRole("button", { name: "Import selected" }).click();
  await expect(page.getByRole("status")).toContainText("1 for review");
  await connect(page);
  await page.getByLabel("Select CodeRED Orion Outlook").check();
  await page.getByRole("button", { name: "Import selected" }).click();
  await expect(page.getByRole("status")).toContainText("1 for review");
  await page.getByRole("button", { name: "Review queue", exact: true }).click();
  await page
    .getByRole("button", { name: "Open CodeRED Orion Outlook", exact: true })
    .click();
  await expect(page.getByText(/Source: Outlook. Received:/)).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Extraction confidence" }),
  ).toContainText("High support");
  await expect(
    page.getByText(/Suggested category: Hackathon \/ workshop/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check possible duplicates" }).click();
  await expect(
    page.getByRole("heading", { name: "Scheduling conflicts" }),
  ).toBeVisible();
  await expect(
    page.getByText("Different commitment", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("CodeRED Orion Hackathon", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Title", { exact: true })
    .fill("CodeRED Orion Outlook confirmed");
  await page.getByRole("button", { name: "Save corrections" }).click();
  await expect(page.getByText(/Current corrections differ/)).toBeVisible();
  await page
    .getByRole("button", { name: "Approve and add", exact: true })
    .click();
  await page.getByRole("button", { name: "Approve and add anyway" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Added to Google Calendar",
  );
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page.getByLabel("Select CodeRED Orion Outlook").check();
  await page.getByRole("button", { name: "Import selected" }).click();
  await expect(page.getByText(/Previously approved/)).toBeVisible();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page
    .getByRole("button", { name: "Disconnect Outlook", exact: true })
    .click();
  await expect(page.getByText("disconnected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review queue", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Open CodeRED Orion Outlook confirmed",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/phase3-outlook-synthetic.png",
    fullPage: true,
  });
});
test("Gmail disconnected leaves connected Outlook usable, then Outlook disconnect leaves Gmail controls intact", async ({
  page,
}) => {
  await page.goto("/test/login");
  await connect(page);
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page.getByRole("button", { name: "Disconnect Google access" }).click();
  await expect(
    page.getByRole("button", { name: "Disconnect Outlook" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await expect(page.getByLabel("Select CodeRED Orion Outlook")).toBeVisible();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page.getByRole("button", { name: "Disconnect Outlook" }).click();
  await expect(
    page.getByRole("link", { name: "Connect Gmail", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect Outlook", exact: true }),
  ).toBeEnabled();
});
