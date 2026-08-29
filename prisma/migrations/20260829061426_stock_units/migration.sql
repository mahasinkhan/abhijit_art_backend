/*
  Warnings:

  - The values [litre,kg,set] on the enum `StockUnit` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "StockUnit_new" AS ENUM ('piece', 'sqft', 'sq_inch', 'inch', 'metre', 'roll', 'sheet', 'box');
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
