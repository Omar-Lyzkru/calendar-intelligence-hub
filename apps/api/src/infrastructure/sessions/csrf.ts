import type { RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
import { AppError } from "@hub/contracts";
export function csrfProtection(origin: string): RequestHandler {
  return (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const expected = res.locals.session?.csrf;
    const actual = req.get("x-csrf-token");
    if (
      req.get("origin") !== origin ||
      !expected ||
      !actual ||
      expected.length !== actual.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
    )
      return next(new AppError("csrf_rejected", 403));
    next();
  };
}
