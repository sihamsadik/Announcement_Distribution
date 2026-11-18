-- AlterTable
ALTER TABLE "SourceGroup" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "SourceGroup_isActive_idx" ON "SourceGroup"("isActive");
