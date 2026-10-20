import { randomBytes, createHash } from "node:crypto";
import { db } from "../persistence/db.js";
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function createSession(userId: string | null = null) {
  const token = randomBytes(32).toString("base64url");
  const session = await db.session.create({
    data: {
      id: hashToken(token),
      userId,
      csrf: randomBytes(32).toString("base64url"),
      expiresAt: new Date(Date.now() + 8 * 3600000),
    },
  });
  return { ...session, token };
}
export async function readSession(token: string) {
  if (!token) return null;
  const s = await db.session.findUnique({
    where: { id: hashToken(token) },
    include: { user: true },
  });
  return s && s.expiresAt > new Date() ? s : null;
}
export async function destroySession(token: string) {
  await db.session.deleteMany({ where: { id: hashToken(token) } });
}
