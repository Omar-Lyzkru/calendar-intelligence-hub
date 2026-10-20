import type { MessageSourceAdapter } from "@hub/contracts";
import type { GmailGateway } from "../infrastructure/google/gmail.js";
import { normalizeGmail } from "../infrastructure/google/mime.js";
export function gmailSource(gmail: GmailGateway): MessageSourceAdapter {
  return {
    provider: "gmail",
    list: (actor, pageToken) => gmail.list(actor, pageToken),
    get: (actor, id) => gmail.get(actor, id),
    normalize: normalizeGmail,
  };
}
