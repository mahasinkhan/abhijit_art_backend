-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "address" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "deliveryMethod" TEXT NOT NULL DEFAULT 'pickup',
ADD COLUMN     "designLink" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "preferredDate" TIMESTAMP(3);
