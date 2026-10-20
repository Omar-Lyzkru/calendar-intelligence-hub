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
function setup(gmail = true, failMicrosoft = false) {
  const imports: unknown[] = [];
  vi.mocked(api).mockImplementation(async (path, _schema, options = {}) => {
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
        status: gmail ? "connected" : "disconnected",
        scopes: gmail ? ["https://www.googleapis.com/auth/gmail.readonly"] : [],
      } as any;
    if (path === "/api/connections/microsoft") {
      if (failMicrosoft) throw Error("synthetic private provider response");
      return { configured: true, status: "connected" } as any;
    }
    if (path === "/api/reviews") return { items: [], nextCursor: null } as any;
    if (path === "/api/gmail/messages")
      return {
        messages: [
          {
            id: "gmail-id",
            subject: "Gmail fixture",
            sender: "fixture@example.test",
            snippet: "Synthetic",
          },
        ],
      } as any;
    if (path === "/api/outlook/messages")
      return {
        messages: [
          {
            id: "opaque-graph-id",
            subject: "Outlook fixture",
            sender: "",
            snippet: "",
            receivedAt: "2026-10-12T12:00:00.000Z",
          },
        ],
      } as any;
    if (path === "/api/imports") {
      imports.push(options.body);
      return { items: [] } as any;
    }
    throw Error("Unexpected synthetic route");
  });
  return imports;
}
it("switching provider clears mailbox selections and binds import to displayed source", async () => {
  const imports = setup();
  render(<App />);
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Messages" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  await userEvent.click(screen.getByRole("button", { name: "Messages" }));
  await userEvent.click(await screen.findByLabelText("Select Gmail fixture"));
  await userEvent.selectOptions(
    screen.getByLabelText("Message source"),
    "outlook",
  );
  await screen.findByLabelText("Select Outlook fixture");
  expect(
    (
      screen.getByRole("button", {
        name: "Import selected",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.queryByText("opaque-graph-id")).toBeNull();
  expect(screen.getByText(/Received:/)).toBeTruthy();
  await userEvent.click(screen.getByLabelText("Select Outlook fixture"));
  await userEvent.click(
    screen.getByRole("button", { name: "Import selected" }),
  );
  await waitFor(() =>
    expect(imports).toEqual([
      { provider: "outlook", externalIds: ["opaque-graph-id"] },
    ]),
  );
  await userEvent.selectOptions(
    screen.getByLabelText("Message source"),
    "gmail",
  );
  const gmailCheckbox = await screen.findByLabelText("Select Gmail fixture");
  expect((gmailCheckbox as HTMLInputElement).checked).toBe(false);
});
it("Outlook-only mailbox connection is usable without Gmail permission", async () => {
  setup(false);
  render(<App />);
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Messages" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  await userEvent.click(screen.getByRole("button", { name: "Messages" }));
  await screen.findByLabelText("Select Outlook fixture");
  expect(
    (screen.getByLabelText("Message source") as HTMLSelectElement).value,
  ).toBe("outlook");
});
it("Microsoft status failure does not stop Gmail listing or expose private error text", async () => {
  setup(true, true);
  render(<App />);
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Messages" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  await userEvent.click(screen.getByRole("button", { name: "Messages" }));
  await screen.findByLabelText("Select Gmail fixture");
  expect(screen.queryByText(/private provider response/)).toBeNull();
});
