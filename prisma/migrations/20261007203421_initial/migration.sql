-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "googleSubject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Chicago',

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" UUID,
    "csrf" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthState" (
    "stateHash" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("stateHash")
);

-- CreateTable
CREATE TABLE "GoogleAuthorization" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "refreshToken" TEXT,
    "scopes" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'connected',

    CONSTRAINT "GoogleAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceConnection" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "authorizationId" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'gmail',
    "externalAccountId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',

    CONSTRAINT "SourceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NormalizedMessage" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sourceConnectionId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sender" TEXT,
    "subject" TEXT,
    "content" TEXT,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "ingestedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "sourceUrl" TEXT,
    "metadata" JSONB NOT NULL,
    "normalizationVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "NormalizedMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DetectedEvent" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "candidate" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DetectedEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewItem" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "detectedEventId" UUID NOT NULL,
    "draft" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'needs_review',
    "approvedSnapshot" JSONB,
    "approvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" UUID NOT NULL,
    "reviewItemId" UUID NOT NULL,
    "calendarId" TEXT NOT NULL DEFAULT 'primary',
    "providerEventId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'writing',
    "leaseUntil" TIMESTAMPTZ(3) NOT NULL,
    "claimToken" TEXT NOT NULL,
    "receipt" JSONB,
    "errorCode" TEXT,

    CONSTRAINT "CalendarEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingAttempt" (
    "id" UUID NOT NULL,
    "sourceConnectionId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "messageId" UUID,
    "stage" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "errorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoryEntry" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "messageId" UUID,
    "reviewId" UUID,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HistoryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSubject_key" ON "User"("googleSubject");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAuthorization_userId_key" ON "GoogleAuthorization"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceConnection_userId_provider_key" ON "SourceConnection"("userId", "provider");

-- CreateIndex
CREATE INDEX "NormalizedMessage_userId_expiresAt_idx" ON "NormalizedMessage"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "NormalizedMessage_sourceConnectionId_externalId_key" ON "NormalizedMessage"("sourceConnectionId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "DetectedEvent_messageId_key" ON "DetectedEvent"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewItem_detectedEventId_key" ON "ReviewItem"("detectedEventId");

-- CreateIndex
CREATE INDEX "ReviewItem_userId_createdAt_idx" ON "ReviewItem"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEvent_reviewItemId_key" ON "CalendarEvent"("reviewItemId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEvent_providerEventId_key" ON "CalendarEvent"("providerEventId");

-- CreateIndex
CREATE INDEX "HistoryEntry_userId_createdAt_idx" ON "HistoryEntry"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthState" ADD CONSTRAINT "OAuthState_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleAuthorization" ADD CONSTRAINT "GoogleAuthorization_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceConnection" ADD CONSTRAINT "SourceConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceConnection" ADD CONSTRAINT "SourceConnection_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "GoogleAuthorization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NormalizedMessage" ADD CONSTRAINT "NormalizedMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NormalizedMessage" ADD CONSTRAINT "NormalizedMessage_sourceConnectionId_fkey" FOREIGN KEY ("sourceConnectionId") REFERENCES "SourceConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DetectedEvent" ADD CONSTRAINT "DetectedEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "NormalizedMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewItem" ADD CONSTRAINT "ReviewItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewItem" ADD CONSTRAINT "ReviewItem_detectedEventId_fkey" FOREIGN KEY ("detectedEventId") REFERENCES "DetectedEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_reviewItemId_fkey" FOREIGN KEY ("reviewItemId") REFERENCES "ReviewItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingAttempt" ADD CONSTRAINT "ProcessingAttempt_sourceConnectionId_fkey" FOREIGN KEY ("sourceConnectionId") REFERENCES "SourceConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingAttempt" ADD CONSTRAINT "ProcessingAttempt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "NormalizedMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoryEntry" ADD CONSTRAINT "HistoryEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
