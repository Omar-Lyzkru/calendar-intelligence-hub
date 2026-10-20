-- A first pending connection has no Microsoft account identity until successful consent.
ALTER TABLE "MicrosoftAuthorization" ALTER COLUMN "accountId" DROP NOT NULL;
-- Bind callback completion to the connection generation to prevent disconnect races.
ALTER TABLE "OAuthState" ADD COLUMN "authorizationRevision" INTEGER;
