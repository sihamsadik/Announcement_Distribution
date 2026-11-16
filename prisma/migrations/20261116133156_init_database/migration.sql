-- CreateEnum
CREATE TYPE "ForwardingStatus" AS ENUM ('SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "SourceGroup" (
    "id" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "topicId" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DestinationGroup" (
    "id" TEXT NOT NULL,
    "sourceGroupId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "groupName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DestinationGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForwardingLog" (
    "id" TEXT NOT NULL,
    "sourceChatId" BIGINT NOT NULL,
    "sourceMessageId" INTEGER NOT NULL,
    "destinationGroupId" TEXT NOT NULL,
    "status" "ForwardingStatus" NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForwardingLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SourceGroup_chatId_idx" ON "SourceGroup"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceGroup_chatId_topicId_key" ON "SourceGroup"("chatId", "topicId");

-- CreateIndex
CREATE INDEX "DestinationGroup_chatId_idx" ON "DestinationGroup"("chatId");

-- CreateIndex
CREATE INDEX "DestinationGroup_sourceGroupId_isActive_idx" ON "DestinationGroup"("sourceGroupId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "DestinationGroup_sourceGroupId_chatId_key" ON "DestinationGroup"("sourceGroupId", "chatId");

-- CreateIndex
CREATE INDEX "ForwardingLog_destinationGroupId_idx" ON "ForwardingLog"("destinationGroupId");

-- CreateIndex
CREATE INDEX "ForwardingLog_status_idx" ON "ForwardingLog"("status");

-- CreateIndex
CREATE INDEX "ForwardingLog_createdAt_idx" ON "ForwardingLog"("createdAt");

-- CreateIndex
CREATE INDEX "ForwardingLog_sourceChatId_sourceMessageId_idx" ON "ForwardingLog"("sourceChatId", "sourceMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "ForwardingLog_sourceChatId_sourceMessageId_destinationGroup_key" ON "ForwardingLog"("sourceChatId", "sourceMessageId", "destinationGroupId");

-- AddForeignKey
ALTER TABLE "DestinationGroup" ADD CONSTRAINT "DestinationGroup_sourceGroupId_fkey" FOREIGN KEY ("sourceGroupId") REFERENCES "SourceGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForwardingLog" ADD CONSTRAINT "ForwardingLog_destinationGroupId_fkey" FOREIGN KEY ("destinationGroupId") REFERENCES "DestinationGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
