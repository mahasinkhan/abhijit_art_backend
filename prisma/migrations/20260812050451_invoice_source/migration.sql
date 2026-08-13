-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "source" "CustomerSource" NOT NULL DEFAULT 'offline';
