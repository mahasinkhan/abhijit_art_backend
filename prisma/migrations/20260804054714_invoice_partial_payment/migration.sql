-- AlterEnum
ALTER TYPE "InvoiceStatus" ADD VALUE 'partial';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
