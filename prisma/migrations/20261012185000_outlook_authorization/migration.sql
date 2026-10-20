-- Add a distinct Microsoft credential store; preserve every existing Gmail row.
CREATE TABLE "MicrosoftAuthorization" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "tenantId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "tokenCache" TEXT,
  "scopes" TEXT[],
  "status" TEXT NOT NULL DEFAULT 'connected',
  "revision" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "MicrosoftAuthorization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MicrosoftAuthorization_userId_key" ON "MicrosoftAuthorization"("userId");
ALTER TABLE "MicrosoftAuthorization" ADD CONSTRAINT "MicrosoftAuthorization_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SourceConnection" ALTER COLUMN "authorizationId" DROP NOT NULL;
ALTER TABLE "SourceConnection" ADD COLUMN "microsoftAuthorizationId" UUID;
ALTER TABLE "SourceConnection" ADD CONSTRAINT "SourceConnection_microsoftAuthorizationId_fkey"
  FOREIGN KEY ("microsoftAuthorizationId") REFERENCES "MicrosoftAuthorization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SourceConnection" ADD CONSTRAINT "SourceConnection_provider_authorization_check" CHECK (
  ("provider" = 'gmail' AND "authorizationId" IS NOT NULL AND "microsoftAuthorizationId" IS NULL)
  OR ("provider" = 'outlook' AND "authorizationId" IS NULL AND "microsoftAuthorizationId" IS NOT NULL)
);
