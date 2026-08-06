-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "discountAmount" INTEGER,
ADD COLUMN     "discountType" TEXT,
ADD COLUMN     "discountValue" DECIMAL(12,2),
ADD COLUMN     "subtotal" INTEGER,
ADD COLUMN     "taxAmount" INTEGER,
ADD COLUMN     "taxPercent" DECIMAL(5,2),
ADD COLUMN     "unitRate" DECIMAL(12,2);
