// @vitest-environment jsdom
import { it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Connections } from "./Connections.js";
afterEach(cleanup);
it("Outlook setup/blocked state is independent from working Google connection controls", () => {
  render(
    <Connections
      timezone="America/Chicago"
      status="connected"
      scopes={[]}
      onTimezone={async () => {}}
      onDisconnect={async () => {}}
      outlook={{ configured: false, status: "disconnected" }}
    />,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Connect Outlook",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByText(/Outlook is not configured/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Connect Gmail" })).toBeTruthy();
});
it("Outlook connect/disconnect actions are separate from Google disconnect", async () => {
  let disconnected = "";
  render(
    <Connections
      timezone="America/Chicago"
      status="connected"
      scopes={[]}
      onTimezone={async () => {}}
      onDisconnect={async () => {
        disconnected = "google";
      }}
      outlook={{ configured: true, status: "connected" }}
      onConnectOutlook={async () => {}}
      onDisconnectOutlook={async () => {
        disconnected = "outlook";
      }}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Disconnect Outlook" }),
  );
  expect(disconnected).toBe("outlook");
  expect(screen.getByText(/does not revoke Microsoft consent/)).toBeTruthy();
});
it("blocked Microsoft access explains school policy without a broader permission request", () => {
  render(
    <Connections
      timezone="America/Chicago"
      status="disconnected"
      scopes={[]}
      onTimezone={async () => {}}
      onDisconnect={async () => {}}
      outlook={{ configured: true, status: "blocked" }}
      onConnectOutlook={async () => {}}
    />,
  );
  expect(
    screen.getByText(/Check Microsoft setup or ask your school administrator/i),
  ).toBeTruthy();
});
it("timezone_edit_and_connection_links", async () => {
  let zone = "";
  render(
    <Connections
      timezone="America/Chicago"
      status="disconnected"
      scopes={[]}
      onTimezone={async (z) => {
        zone = z;
      }}
      onDisconnect={async () => {}}
    />,
  );
  const input = screen.getByLabelText("Default timezone");
  await userEvent.clear(input);
  await userEvent.type(input, "America/New_York");
  await userEvent.click(screen.getByRole("button", { name: "Save timezone" }));
  expect(zone).toBe("America/New_York");
  expect(
    screen.getByRole("link", { name: "Connect Gmail" }).getAttribute("href"),
  ).toBe("/auth/google/start?intent=gmail");
});
