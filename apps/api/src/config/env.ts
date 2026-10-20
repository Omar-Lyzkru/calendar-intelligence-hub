import { z } from "zod";
const optional = <T extends z.ZodType>(value: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), value.optional());
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_ORIGIN: z.url(),
  DATABASE_URL: z.string().startsWith("postgresql://"),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.url(),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/i),
  MICROSOFT_CLIENT_ID: optional(z.uuid()),
  MICROSOFT_TENANT_ID: optional(z.uuid()),
  MICROSOFT_CLIENT_SECRET: optional(z.string().min(1).max(4096)),
  MICROSOFT_REDIRECT_URI: optional(z.url()),
  AUTOMATION_LIVE_WRITES_ENABLED: optional(
    z.enum(["true", "false"]).transform((v) => v === "true"),
  ),
  DISCORD_BOT_TOKEN: optional(z.string()),
  DISCORD_GUILD_ID: optional(z.string()),
  DISCORD_CHANNEL_IDS: optional(z.string()),
  PROVIDER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(20000)
    .default(15000),
});
export function loadConfig(input: Record<string, string | undefined>) {
  const config = schema.parse(input);
  const microsoft = [
    config.MICROSOFT_CLIENT_ID,
    config.MICROSOFT_TENANT_ID,
    config.MICROSOFT_CLIENT_SECRET,
    config.MICROSOFT_REDIRECT_URI,
  ];
  if (microsoft.some(Boolean)) {
    if (!microsoft.every(Boolean))
      throw new Error("Microsoft configuration must be complete");
    const expected = new URL(
      "/auth/microsoft/callback",
      new URL(config.APP_ORIGIN).origin,
    ).toString();
    if (config.MICROSOFT_REDIRECT_URI !== expected)
      throw new Error(
        "Microsoft callback must match the application origin and route",
      );
    if (
      config.NODE_ENV === "production" &&
      !config.MICROSOFT_REDIRECT_URI.startsWith("https://")
    )
      throw new Error("Microsoft production callback requires HTTPS");
  }
  if (
    config.NODE_ENV === "production" &&
    (!config.APP_ORIGIN.startsWith("https://") ||
      !config.GOOGLE_REDIRECT_URI.startsWith("https://"))
  )
    throw new Error("Production requires HTTPS");
  if (
    new URL(config.GOOGLE_REDIRECT_URI).origin !==
    new URL(config.APP_ORIGIN).origin
  )
    throw new Error("Callback must share application origin");
  return config;
}
export type Config = ReturnType<typeof loadConfig>;
