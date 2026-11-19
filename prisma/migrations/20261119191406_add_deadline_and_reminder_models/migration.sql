-- CreateEnum
CREATE TYPE "DeadlineStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReminderType" AS ENUM ('REMINDER_24_HOUR', 'ADDITIONAL');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Deadline" (
    "id" TEXT NOT NULL,
    "sourceGroupId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Addis_Ababa',
    "status" "DeadlineStatus" NOT NULL DEFAULT 'ACTIVE',
    "additionalReminderAt" TIMESTAMP(3),
    "createdBy" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deadline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeadlineAnnouncement" (
    "id" TEXT NOT NULL,
    "deadlineId" TEXT NOT NULL,
    "destinationGroupId" TEXT NOT NULL,
    "telegramMessageId" INTEGER,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "pinErrorMessage" TEXT,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeadlineAnnouncement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeadlineReminderDelivery" (
    "id" TEXT NOT NULL,
    "deadlineId" TEXT NOT NULL,
    "destinationGroupId" TEXT NOT NULL,
    "reminderType" "ReminderType" NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "telegramMessageId" INTEGER,
    "errorMessage" TEXT,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeadlineReminderDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Deadline_sourceGroupId_idx" ON "Deadline"("sourceGroupId");

-- CreateIndex
CREATE INDEX "Deadline_status_dueAt_idx" ON "Deadline"("status", "dueAt");

-- CreateIndex
CREATE INDEX "DeadlineAnnouncement_deadlineId_idx" ON "DeadlineAnnouncement"("deadlineId");

-- CreateIndex
CREATE INDEX "DeadlineAnnouncement_destinationGroupId_idx" ON "DeadlineAnnouncement"("destinationGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "DeadlineAnnouncement_deadlineId_destinationGroupId_key" ON "DeadlineAnnouncement"("deadlineId", "destinationGroupId");

-- CreateIndex
CREATE INDEX "DeadlineReminderDelivery_deadlineId_idx" ON "DeadlineReminderDelivery"("deadlineId");

-- CreateIndex
CREATE INDEX "DeadlineReminderDelivery_destinationGroupId_idx" ON "DeadlineReminderDelivery"("destinationGroupId");

-- CreateIndex
CREATE INDEX "DeadlineReminderDelivery_status_scheduledFor_idx" ON "DeadlineReminderDelivery"("status", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "DeadlineReminderDelivery_deadlineId_destinationGroupId_remi_key" ON "DeadlineReminderDelivery"("deadlineId", "destinationGroupId", "reminderType");

-- AddForeignKey
ALTER TABLE "Deadline" ADD CONSTRAINT "Deadline_sourceGroupId_fkey" FOREIGN KEY ("sourceGroupId") REFERENCES "SourceGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadlineAnnouncement" ADD CONSTRAINT "DeadlineAnnouncement_deadlineId_fkey" FOREIGN KEY ("deadlineId") REFERENCES "Deadline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadlineAnnouncement" ADD CONSTRAINT "DeadlineAnnouncement_destinationGroupId_fkey" FOREIGN KEY ("destinationGroupId") REFERENCES "DestinationGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadlineReminderDelivery" ADD CONSTRAINT "DeadlineReminderDelivery_deadlineId_fkey" FOREIGN KEY ("deadlineId") REFERENCES "Deadline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadlineReminderDelivery" ADD CONSTRAINT "DeadlineReminderDelivery_destinationGroupId_fkey" FOREIGN KEY ("destinationGroupId") REFERENCES "DestinationGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
