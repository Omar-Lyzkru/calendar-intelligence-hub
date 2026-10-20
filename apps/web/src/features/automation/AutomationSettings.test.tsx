// @vitest-environment jsdom
import { it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutomationSettings } from "./AutomationSettings.js";
import { api } from "../../api/client.js";
vi.mock("../../api/client.js", () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const policy = {
  enabled: false,
  pollGmail: false,
  rules: [],
  revision: 1,
  enabledAt: null,
  liveWritesEnabled: false,
};
function mock() {
  vi.mocked(api).mockImplementation(async (path) =>
    path === "/api/automation/sources"
      ? ({
          items: [
            {
              id: "80000000-0000-4000-8000-000000000001",
              provider: "gmail",
              status: "connected",
              channelIds: [],
            },
          ],
        } as any)
      : (policy as any),
  );
}
it("automatic actions and imports default off and live acceptance pause is visible", async () => {
  mock();
  render(<AutomationSettings />);
  const enabled = await screen.findByLabelText(
    "Enable automatic Calendar actions",
  );
  expect((enabled as HTMLInputElement).checked).toBe(false);
  expect(
    (
      screen.getByLabelText(
        "Enable automatic Gmail imports",
      ) as HTMLInputElement
    ).checked,
  ).toBe(false);
  expect(screen.getByText(/paused for live acceptance/)).toBeTruthy();
});
it("source/category rule is explicit and save uses the displayed policy revision", async () => {
  mock();
  let submitted: any;
  vi.mocked(api).mockImplementation(async (path, _schema, options) => {
    if (options?.method === "PUT") {
      submitted = options.body;
      return {
        ...policy,
        ...(options.body as Record<string, unknown>),
        revision: 2,
      } as any;
    }
    return path === "/api/automation/sources"
      ? ({
          items: [
            {
              id: "80000000-0000-4000-8000-000000000001",
              provider: "gmail",
              status: "connected",
              channelIds: [],
            },
          ],
        } as any)
      : (policy as any);
  });
  render(<AutomationSettings />);
  await screen.findByLabelText("Enable automatic Calendar actions");
  await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
  await userEvent.selectOptions(screen.getByLabelText("Rule 1 action"), "auto");
  await userEvent.click(
    screen.getByLabelText("Enable automatic Calendar actions"),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Save automation settings" }),
  );
  await waitFor(() =>
    expect(submitted).toMatchObject({
      enabled: true,
      expectedRevision: 1,
      rules: [
        {
          connectionId: "80000000-0000-4000-8000-000000000001",
          category: "exam_quiz",
          action: "auto",
        },
      ],
    }),
  );
});
it("failed settings save preserves restrictions without exposing diagnostics", async () => {
  mock();
  vi.mocked(api).mockImplementation(async (path, _schema, options) => {
    if (options?.method === "PUT") throw Error("PRIVATE_SETTINGS_SENTINEL");
    return path === "/api/automation/sources"
      ? ({ items: [] } as any)
      : (policy as any);
  });
  render(<AutomationSettings />);
  await screen.findByLabelText("Enable automatic Calendar actions");
  await userEvent.click(
    screen.getByLabelText("Enable automatic Calendar actions"),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Save automation settings" }),
  );
  expect((await screen.findByRole("alert")).textContent).not.toContain(
    "PRIVATE_SETTINGS_SENTINEL",
  );
  expect(
    (
      screen.getByLabelText(
        "Enable automatic Calendar actions",
      ) as HTMLInputElement
    ).checked,
  ).toBe(true);
});
