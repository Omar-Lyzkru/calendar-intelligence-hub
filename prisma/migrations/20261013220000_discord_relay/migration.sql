-- Additive relay bindings and minimal source receipts; existing sources and approvals are untouched.
CREATE TABLE "DiscordRelay" (
 "id" UUID PRIMARY KEY, "userId" UUID NOT NULL UNIQUE REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "guildId" TEXT NOT NULL UNIQUE, "channelIds" TEXT[] NOT NULL,
 "generation" INTEGER NOT NULL DEFAULT 1 CHECK ("generation">0), "status" TEXT NOT NULL DEFAULT 'connected'
);
ALTER TABLE "SourceConnection" ADD COLUMN "discordRelayId" UUID REFERENCES "DiscordRelay"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SourceConnection" DROP CONSTRAINT "SourceConnection_provider_authorization_check";
ALTER TABLE "SourceConnection" ADD CONSTRAINT "SourceConnection_provider_authorization_check" CHECK (
 (provider='gmail' AND "authorizationId" IS NOT NULL AND "microsoftAuthorizationId" IS NULL AND "discordRelayId" IS NULL) OR
 (provider='outlook' AND "authorizationId" IS NULL AND "microsoftAuthorizationId" IS NOT NULL AND "discordRelayId" IS NULL) OR
 (provider='discord' AND "authorizationId" IS NULL AND "microsoftAuthorizationId" IS NULL AND "discordRelayId" IS NOT NULL)
);
CREATE TABLE "DiscordObservation" (
 "id" UUID PRIMARY KEY, "sourceConnectionId" UUID NOT NULL REFERENCES "SourceConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "externalId" TEXT NOT NULL, "channelId" TEXT NOT NULL,
 "messageId" UUID UNIQUE REFERENCES "NormalizedMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE,
 "status" TEXT NOT NULL, "errorCode" TEXT, "sourceState" TEXT NOT NULL DEFAULT 'current',
 "sourceRevision" INTEGER NOT NULL DEFAULT 1, "acknowledgedRevision" INTEGER NOT NULL DEFAULT 1,
 "observedEditedAt" TIMESTAMPTZ(3), "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "DiscordObservation_revision_check" CHECK ("sourceRevision">0 AND "acknowledgedRevision">0 AND "acknowledgedRevision"<="sourceRevision")
);
CREATE UNIQUE INDEX "DiscordObservation_sourceConnectionId_externalId_key" ON "DiscordObservation"("sourceConnectionId","externalId");
