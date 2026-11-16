-- AlterEnum
ALTER TYPE "ForwardingStatus" ADD VALUE 'RETRYING';

-- AlterTable
ALTER TABLE "ForwardingLog" ADD COLUMN     "lastAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "nextRetryAt" TIMESTAMP(3),
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "ForwardingLog_status_nextRetryAt_idx" ON "ForwardingLog"("status", "nextRetryAt");
