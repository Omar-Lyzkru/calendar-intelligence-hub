import type {
  INetworkModule,
  NetworkRequestOptions,
  NetworkResponse,
} from "@azure/msal-node";
import { AppError } from "@hub/contracts";
export async function boundedJson(
  response: Response,
  limit = 1048576,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new AppError("invalid_provider_payload", 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new AppError("message_too_large", 422);
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new AppError("invalid_provider_payload", 502);
    }
  } finally {
    reader.releaseLock();
  }
}
export function microsoftNetwork(timeout: number): INetworkModule {
  async function send<T>(
    url: string,
    method: "GET" | "POST",
    options?: NetworkRequestOptions,
  ): Promise<NetworkResponse<T>> {
    try {
      const u = new URL(url);
      if (
        u.origin !== "https://login.microsoftonline.com" ||
        u.username ||
        u.password ||
        u.hash
      )
        throw new AppError("microsoft_unavailable", 503);
      const response = await fetch(url, {
        method,
        headers: options?.headers,
        body: options?.body,
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
      if (response.status >= 300 && response.status < 400)
        throw new AppError("microsoft_unavailable", 503);
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: (await boundedJson(response)) as T,
      };
    } catch {
      throw new AppError("microsoft_unavailable", 503);
    }
  }
  return {
    sendGetRequestAsync: <T>(url: string, options?: NetworkRequestOptions) =>
      send<T>(url, "GET", options),
    sendPostRequestAsync: <T>(url: string, options?: NetworkRequestOptions) =>
      send<T>(url, "POST", options),
  };
}
