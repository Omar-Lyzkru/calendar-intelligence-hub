import { z } from "zod";
import { safeMessage, BlockerSchema, type Blocker } from "@hub/contracts";
export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
    public blockers: Blocker[] = [],
    public retryAfterSeconds?: number,
  ) {
    super(safeMessage(code));
    if (code === "microsoft_rate_limited" && retryAfterSeconds)
      this.message += ` Wait at least ${retryAfterSeconds} seconds.`;
  }
}
let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method || "GET",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.method && options.method !== "GET"
        ? { "x-csrf-token": csrf }
        : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  const data: unknown = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const parsed = z
      .object({
        error: z.object({
          code: z.string(),
          blockers: z.array(BlockerSchema).optional(),
        }),
      })
      .safeParse(data);
    throw new ApiError(
      parsed.success ? parsed.data.error.code : "request_failed",
      response.status,
      parsed.success ? parsed.data.error.blockers || [] : [],
      (() => {
        const value = response.headers.get("Retry-After");
        const seconds = value && /^\d+$/.test(value) ? Number(value) : 0;
        return seconds >= 1 && seconds <= 86400 ? seconds : undefined;
      })(),
    );
  }
  return schema.parse(data);
}
