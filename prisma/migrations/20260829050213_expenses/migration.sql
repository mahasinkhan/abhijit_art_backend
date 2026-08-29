-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('salary', 'advance', 'rent', 'utilities', 'transport', 'materials', 'food', 'maintenance', 'marketing', 'other');

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" "ExpenseCategory" NOT NULL DEFAULT 'other',
    "title" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'cash',
    "paidToId" TEXT,
    "paidToName" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Expense_date_idx" ON "Expense"("date");

-- CreateIndex
CREATE INDEX "Expense_category_idx" ON "Expense"("category");

-- CreateIndex
CREATE INDEX "Expense_paidToId_idx" ON "Expense"("paidToId");

-- CreateIndex
CREATE INDEX "Expense_method_idx" ON "Expense"("method");

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_paidToId_fkey" FOREIGN KEY ("paidToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
