-- CreateEnum
CREATE TYPE "CustomerSource" AS ENUM ('online', 'offline');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "address" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "source" "CustomerSource" NOT NULL DEFAULT 'online';
