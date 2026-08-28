/*
  Warnings:

  - A unique constraint covering the columns `[khataEntryId]` on the table `Task` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "KhataEntry" ADD COLUMN     "workDetails" TEXT NOT NULL DEFAULT '',
ALTER COLUMN "items" SET DEFAULT '[]';

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "khataEntryId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Task_khataEntryId_key" ON "Task"("khataEntryId");

-- CreateIndex
CREATE INDEX "Task_khataEntryId_idx" ON "Task"("khataEntryId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_khataEntryId_fkey" FOREIGN KEY ("khataEntryId") REFERENCES "KhataEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
