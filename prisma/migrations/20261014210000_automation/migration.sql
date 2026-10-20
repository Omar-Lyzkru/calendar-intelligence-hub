-- CreateTable
CREATE TABLE "AutomationPolicy" (
    "userId" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMPTZ(3),
    "pollGmail" BOOLEAN NOT NULL DEFAULT false,
    "gmailPollingEnabledAt" TIMESTAMPTZ(3),
    "rules" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "AutomationPolicy_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "AutomationDecision" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "reviewId" UUID,
    "reviewRevision" INTEGER NOT NULL,
    "policyRevision" INTEGER NOT NULL,
    "sourceRevision" INTEGER NOT NULL DEFAULT 1,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "confirmedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confirmedRevision" INTEGER,
    "duplicateFingerprint" TEXT,
    "conflictFingerprint" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AutomationDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationQuestion" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "decisionId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "reviewRevision" INTEGER NOT NULL,
    "policyRevision" INTEGER NOT NULL,
    "sourceRevision" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "advisoryFingerprint" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AutomationQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestionPoll" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "watermark" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3),
    "pageToken" TEXT,
    "pendingIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "failures" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "nextRunAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngestionPoll_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AutomationDecision_messageId_key" ON "AutomationDecision"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationDecision_reviewId_key" ON "AutomationDecision"("reviewId");

-- CreateIndex
CREATE INDEX "AutomationDecision_userId_updatedAt_idx" ON "AutomationDecision"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "AutomationQuestion_decisionId_status_idx" ON "AutomationQuestion"("decisionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "IngestionPoll_connectionId_key" ON "IngestionPoll"("connectionId");

-- AddForeignKey
ALTER TABLE "AutomationPolicy" ADD CONSTRAINT "AutomationPolicy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationDecision" ADD CONSTRAINT "AutomationDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationDecision" ADD CONSTRAINT "AutomationDecision_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "NormalizedMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationDecision" ADD CONSTRAINT "AutomationDecision_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "ReviewItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationQuestion" ADD CONSTRAINT "AutomationQuestion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationQuestion" ADD CONSTRAINT "AutomationQuestion_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "AutomationDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestionPoll" ADD CONSTRAINT "IngestionPoll_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestionPoll" ADD CONSTRAINT "IngestionPoll_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SourceConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Conservative defaults and bounded state remain enforced outside the client.
ALTER TABLE "AutomationPolicy" ADD CONSTRAINT "automation_policy_shape" CHECK (revision > 0 AND jsonb_typeof(rules)='array' AND jsonb_array_length(rules)<=100 AND (NOT enabled OR "enabledAt" IS NOT NULL) AND (NOT (enabled AND "pollGmail") OR "gmailPollingEnabledAt" IS NOT NULL));
ALTER TABLE "AutomationDecision" ADD CONSTRAINT "automation_decision_kind" CHECK (decision IN ('auto_handle','ask_user','skip','blocked') AND "reviewRevision">=0 AND "policyRevision">0 AND "sourceRevision">0);
ALTER TABLE "AutomationQuestion" ADD CONSTRAINT "automation_question_status" CHECK (status IN ('open','answered','invalidated') AND kind IN ('title','date','time','all_day','timezone','facts','duplicate','conflict','source','category'));
CREATE UNIQUE INDEX "AutomationQuestion_one_open" ON "AutomationQuestion"("decisionId") WHERE status='open';
ALTER TABLE "IngestionPoll" ADD CONSTRAINT "ingestion_poll_bound" CHECK (failures>=0 AND cardinality("pendingIds")<=20 AND status IN ('ready','retry','blocked'));
