import type { RequestHandler } from "express";
import { AppError } from "@hub/contracts";
import { readSession } from "../infrastructure/sessions/store.js";
import { readCookie } from "../infrastructure/sessions/cookies.js";
export const sessionMiddleware: RequestHandler = async (req, res, next) => {
  try {
    res.locals.session = await readSession(readCookie(req));
    next();
  } catch (e) {
    next(e);
  }
};
export const requireActor: RequestHandler = (_req, res, next) => {
  const userId = res.locals.session?.userId;
  if (!userId) return next(new AppError("authentication_required", 401));
  res.locals.actor = { userId };
  next();
};
