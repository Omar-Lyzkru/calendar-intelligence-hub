import type { Response, Request } from "express";
export function readCookie(req: Request) {
  return (
    req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("hub_session="))
      ?.slice(12) || ""
  );
}
export function setSessionCookie(
  res: Response,
  token: string,
  production: boolean,
) {
  res.cookie("hub_session", token, {
    httpOnly: true,
    secure: production,
    sameSite: "lax",
    path: "/",
    maxAge: 8 * 3600000,
  });
}
