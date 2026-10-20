import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
const path = ".env";
const text = readFileSync(path, "utf8");
const existing = text.match(/^TOKEN_ENCRYPTION_KEY=(.*)$/m)?.[1].trim();
if (existing) {
  console.log("Encryption key already configured; kept unchanged.");
} else {
  const line = "TOKEN_ENCRYPTION_KEY=" + randomBytes(32).toString("hex");
  writeFileSync(
    path,
    text.match(/^TOKEN_ENCRYPTION_KEY=.*$/m)
      ? text.replace(/^TOKEN_ENCRYPTION_KEY=.*$/m, line)
      : text + "\n" + line + "\n",
    { mode: 0o600 },
  );
  console.log("Encryption key saved to local .env.");
}
