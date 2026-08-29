/*
  Warnings:

  - You are about to drop the column `paidToId` on the `Expense` table. All the data in the column will be lost.
  - You are about to drop the column `paidToName` on the `Expense` table. All the data in the column will be lost.
  - Added the required column `payeeId` to the `Expense` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "PayeeKind" AS ENUM ('employee', 'outsider');

-- DropForeignKey
ALTER TABLE "Expense" DROP CONSTRAINT "Expense_paidToId_fkey";

-- DropIndex
DROP INDEX "Expense_paidToId_idx";

-- AlterTable
ALTER TABLE "Expense" DROP COLUMN "paidToId",
DROP COLUMN "paidToName",
ADD COLUMN     "payeeId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "Payee" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "kind" "PayeeKind" NOT NULL DEFAULT 'outsider',
    "userId" TEXT,
    "role" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payee_phone_key" ON "Payee"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Payee_userId_key" ON "Payee"("userId");

-- CreateIndex
CREATE INDEX "Payee_name_idx" ON "Payee"("name");

-- CreateIndex
CREATE INDEX "Payee_kind_idx" ON "Payee"("kind");

-- CreateIndex
CREATE INDEX "Payee_active_idx" ON "Payee"("active");

-- CreateIndex
CREATE INDEX "Expense_payeeId_date_idx" ON "Expense"("payeeId", "date");

-- AddForeignKey
ALTER TABLE "Payee" ADD CONSTRAINT "Payee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_payeeId_fkey" FOREIGN KEY ("payeeId") REFERENCES "Payee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
