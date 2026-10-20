import { it, expect } from "vitest";
import { encryptToken, decryptToken } from "./tokenVault.js";
it("token_ciphertext_does_not_contain_plaintext", () => {
  const key = "1".repeat(64),
    token = "synthetic-refresh-secret";
  const cipher = encryptToken(token, key);
  expect(cipher).not.toContain(token);
  expect(decryptToken(cipher, key)).toBe(token);
  expect(encryptToken(token, key)).not.toBe(cipher);
});
it("tampered_ciphertext_is_rejected", () => {
  const c = encryptToken("private", "1".repeat(64));
  expect(() => decryptToken(c.slice(0, -4) + "AAAA", "1".repeat(64))).toThrow();
});
