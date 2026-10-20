import type { ErrorRequestHandler } from "express";
import { AppError, safeErrorCode } from "@hub/contracts";
import { ZodError } from "zod";
export const errors: ErrorRequestHandler = (error, _req, res, _next) => {
  const requestId = crypto.randomUUID();
  const status =
    error instanceof AppError
      ? error.status
      : error instanceof ZodError
        ? 422
        : 500;
  const code =
    error instanceof AppError
      ? safeErrorCode(error.code)
      : error instanceof ZodError
        ? "invalid_input"
        : "internal_error";
  console.error(JSON.stringify({ requestId, code, status }));
  if (
    error instanceof AppError &&
    error.code === "microsoft_rate_limited" &&
    Number.isInteger(error.retryAfterSeconds) &&
    error.retryAfterSeconds! >= 1 &&
    error.retryAfterSeconds! <= 86400
  )
    res.set("Retry-After", String(error.retryAfterSeconds));
  res.status(status).json({
    error: {
      code,
      requestId,
      ...(error instanceof AppError &&
      error.code === "incomplete_event" &&
      error.details
        ? error.details
        : {}),
    },
  });
};
