import { OAuth2Client } from "google-auth-library";
import { AppError, type Actor } from "@hub/contracts";
import { db } from "../persistence/db.js";
import { decryptToken } from "./tokenVault.js";
import type { Config } from "../../config/env.js";
export async function providerClient(
  actor: Actor,
  scope: string,
  config: Config,
  refresh?: (client: OAuth2Client) => Promise<void>,
): Promise<OAuth2Client> {
  const auth = await db.googleAuthorization.findUnique({
    where: { userId: actor.userId },
  });
  if (
    !auth?.refreshToken ||
    auth.status !== "connected" ||
    !auth.scopes.includes(scope)
  )
    throw new AppError("reauthorization_required", 403);
  const client = new OAuth2Client({
    clientId: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    redirectUri: config.GOOGLE_REDIRECT_URI,
    transporterOptions: { timeout: config.PROVIDER_TIMEOUT_MS, retry: false },
  });
  client.setCredentials({
    refresh_token: decryptToken(auth.refreshToken, config.TOKEN_ENCRYPTION_KEY),
  });
  try {
    if (refresh) await refresh(client);
    else await client.getAccessToken();
  } catch (error) {
    const e = error as { response?: { data?: { error?: string } } };
    if (e.response?.data?.error === "invalid_grant") {
      await db.googleAuthorization.update({
        where: { id: auth.id },
        data: { status: "reauthorization_required" },
      });
      throw new AppError("reauthorization_required", 403);
    }
    throw new AppError("provider_unavailable", 503);
  }
  return client;
}
