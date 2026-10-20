import { it, expect } from "vitest";
import { spawn } from "node:child_process";
it("compiled_server_serves_app_and_protected_api_without_test_routes", async () => {
  const port = 43173;
  const child = spawn(process.execPath, ["dist/apps/api/src/server.js"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      APP_ORIGIN: "https://localhost:" + port,
      GOOGLE_REDIRECT_URI:
        "https://localhost:" + port + "/auth/google/callback",
      GOOGLE_CLIENT_ID: "synthetic",
      GOOGLE_CLIENT_SECRET: "synthetic",
      TOKEN_ENCRYPTION_KEY: "1".repeat(64),
      // Prisma fills missing environment entries from .env; blanks keep local
      // Microsoft credentials out of this synthetic production-startup check.
      MICROSOFT_CLIENT_ID: "",
      MICROSOFT_TENANT_ID: "",
      MICROSOFT_CLIENT_SECRET: "",
      MICROSOFT_REDIRECT_URI: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  child.stderr.resume();
  let readyResolve: () => void = () => {};
  let readyReject: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.stdout.on("data", (data) => {
    if (String(data).includes("server_started")) readyResolve();
  });
  child.on("error", readyReject);
  child.on("exit", () =>
    readyReject(Error("compiled server exited before startup")),
  );
  try {
    await ready;
    const home = await fetch("http://127.0.0.1:" + port + "/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('<div id="root"></div>');
    const me = await fetch("http://127.0.0.1:" + port + "/api/me");
    expect(me.headers.get("set-cookie")).toContain("Secure");
    expect(me.headers.get("set-cookie")).toContain("HttpOnly");
    expect(
      (await fetch("http://127.0.0.1:" + port + "/api/gmail/messages")).status,
    ).toBe(401);
    expect(
      (await fetch("http://127.0.0.1:" + port + "/api/test/login")).status,
    ).toBe(404);
  } finally {
    child.kill("SIGTERM");
    await closed;
  }
}, 10000);
