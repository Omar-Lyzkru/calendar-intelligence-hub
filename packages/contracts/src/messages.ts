export interface Actor {
  userId: string;
}
export type MessageProvider = "gmail" | "outlook" | "discord";
export interface NormalizationContext {
  id: string;
  userId: string;
  sourceConnectionId: string;
  ingestedAt: string;
}
export interface NormalizedMessage {
  id: string;
  userId: string;
  sourceConnectionId: string;
  source: MessageProvider;
  externalId: string;
  sender?: string;
  channel?: string;
  subject?: string;
  content: string;
  receivedAt: string;
  ingestedAt: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
  normalizationVersion: number;
}
export interface MessageSummary {
  id: string;
  subject: string;
  sender: string;
  snippet: string;
  receivedAt?: string;
}
export interface MessagePage {
  messages: MessageSummary[];
  nextPageToken?: string;
}
export interface Clock {
  now(): Date;
}
export interface MessageSourceAdapter {
  provider: MessageProvider;
  list(actor: Actor, pageToken?: string): Promise<MessagePage>;
  get(actor: Actor, externalId: string): Promise<unknown>;
  normalize(payload: unknown, context: NormalizationContext): NormalizedMessage;
}
