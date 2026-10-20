// @vitest-environment jsdom
import { it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App.js";
import { api } from "./api/client.js";
vi.mock("./api/client.js", async (original) => ({
  ...(await original<typeof import("./api/client.js")>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function setup(fail = false) {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/me")
      return {
        user: {
          id: "synthetic",
          email: "synthetic@example.test",
          timezone: "America/Chicago",
        },
        csrf: "synthetic",
      } as any;
    if (path === "/api/connections")
      return {
        status: "connected",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      } as any;
    if (path === "/api/connections/microsoft")
      return { configured: false, status: "disconnected" } as any;
    if (path === "/api/connections/discord") {
      if (fail) throw Error("private raw token diagnostics");
      return {
        configured: true,
        status: "connected",
        runtime: { state: "connected", coverage: "capped" },
      } as any;
    }
    if (path === "/api/reviews") return { items: [], nextCursor: null } as any;
    if (path === "/api/gmail/messages")
      return {
        messages: [
          {
            id: "synthetic",
            subject: "Gmail fixture",
            sender: "",
            snippet: "",
          },
        ],
      } as any;
    if (path === "/api/discord/messages")
      return {
        items: [
          {
            id: "synthetic-local-id",
            title: "Discord fixture",
            status: "review",
            reviewId: "synthetic-review",
            receivedAt: "2026-10-13T12:00:00.000Z",
          },
        ],
        failures: [],
      } as any;
    throw Error("Unexpected synthetic route");
  });
}
it("Discord displays already imported candidates and has no manual production import controls", async () => {
  setup();
  render(<App />);
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Messages" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  await userEvent.click(screen.getByRole("button", { name: "Messages" }));
  await userEvent.selectOptions(
    screen.getByLabelText("Message source"),
    "discord",
  );
  await screen.findByText("Discord fixture");
  expect(screen.queryByRole("button", { name: "Import selected" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Review Discord fixture" }),
  ).toBeTruthy();
  expect(screen.queryByText("synthetic-local-id")).toBeNull();
});
it("Discord status failure leaves Gmail usable and does not leak private diagnostics", async () => {
  setup(true);
  render(<App />);
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Messages" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  await userEvent.click(screen.getByRole("button", { name: "Messages" }));
  await screen.findByLabelText("Select Gmail fixture");
  await userEvent.click(screen.getByRole("button", { name: "Connections" }));
  expect(await screen.findByText(/Discord status is unavailable/)).toBeTruthy();
  expect(screen.queryByText(/private raw token/)).toBeNull();
});
