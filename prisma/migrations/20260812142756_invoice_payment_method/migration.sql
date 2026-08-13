-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'online');

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'cash';
