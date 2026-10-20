import type { Blocker } from "./readiness.js";
export class AppError extends Error {
  retryAfterSeconds?: number;
  constructor(
    public code: string,
    public status = 400,
    public details?: { blockers: Blocker[]; missingFields: string[] },
  ) {
    super(code);
  }
}
