/*
  Warnings:

  - The values [sq_inch,inch] on the enum `StockUnit` will be removed. If these variants are still used in the database, this will fail.
  - The `category` column on the `Expense` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "TxnCategory" AS ENUM ('salary', 'advance', 'lent', 'rent', 'utilities', 'transport', 'materials', 'food', 'maintenance', 'marketing', 'other', 'sale', 'loan_back', 'refund', 'other_income');

-- CreateEnum
CREATE TYPE "TxnKind" AS ENUM ('income', 'expense');

-- AlterEnum
BEGIN;
CREATE TYPE "StockUnit_new" AS ENUM ('piece', 'sqft', 'metre', 'roll', 'sheet', 'litre', 'kg', 'box', 'set');
ALTER TABLE "public"."InventoryItem" ALTER COLUMN "unit" DROP DEFAULT;
ALTER TABLE "public"."SupplierPurchaseItem" ALTER COLUMN "unit" DROP DEFAULT;
ALTER TABLE "InventoryItem" ALTER COLUMN "unit" TYPE "StockUnit_new" USING ("unit"::text::"StockUnit_new");
ALTER TABLE "SupplierPurchaseItem" ALTER COLUMN "unit" TYPE "StockUnit_new" USING ("unit"::text::"StockUnit_new");
ALTER TYPE "StockUnit" RENAME TO "StockUnit_old";
ALTER TYPE "StockUnit_new" RENAME TO "StockUnit";
DROP TYPE "public"."StockUnit_old";
ALTER TABLE "InventoryItem" ALTER COLUMN "unit" SET DEFAULT 'piece';
ALTER TABLE "SupplierPurchaseItem" ALTER COLUMN "unit" SET DEFAULT 'piece';
COMMIT;

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "kind" "TxnKind" NOT NULL DEFAULT 'expense',
DROP COLUMN "category",
ADD COLUMN     "category" "TxnCategory" NOT NULL DEFAULT 'other',
ALTER COLUMN "payeeId" DROP NOT NULL;

-- DropEnum
DROP TYPE "ExpenseCategory";

-- CreateIndex
CREATE INDEX "Expense_kind_date_idx" ON "Expense"("kind", "date");

-- CreateIndex
CREATE INDEX "Expense_category_idx" ON "Expense"("category");
