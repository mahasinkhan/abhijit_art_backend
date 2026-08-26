-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "purchaseId" TEXT;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "lastPurchaseAt" TIMESTAMP(3),
ADD COLUMN     "totalPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "totalPurchased" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "SupplierPurchase" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "billNo" TEXT NOT NULL DEFAULT '',
    "billDate" TIMESTAMP(3) NOT NULL,
    "discType" "DiscountType" NOT NULL DEFAULT 'amount',
    "discVal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taxPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "discountAmt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxAmt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPurchaseItem" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "itemId" TEXT,
    "name" TEXT NOT NULL,
    "unit" "StockUnit" NOT NULL DEFAULT 'piece',
    "quantity" DECIMAL(14,3) NOT NULL,
    "rate" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPurchaseItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPayment" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'cash',
    "note" TEXT NOT NULL DEFAULT '',
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierPurchase_supplierId_billDate_idx" ON "SupplierPurchase"("supplierId", "billDate");

-- CreateIndex
CREATE INDEX "SupplierPurchase_billDate_idx" ON "SupplierPurchase"("billDate");

-- CreateIndex
CREATE INDEX "SupplierPurchase_billNo_idx" ON "SupplierPurchase"("billNo");

-- CreateIndex
CREATE INDEX "SupplierPurchaseItem_purchaseId_idx" ON "SupplierPurchaseItem"("purchaseId");

-- CreateIndex
CREATE INDEX "SupplierPurchaseItem_itemId_idx" ON "SupplierPurchaseItem"("itemId");

-- CreateIndex
CREATE INDEX "SupplierPayment_supplierId_paidAt_idx" ON "SupplierPayment"("supplierId", "paidAt");

-- CreateIndex
CREATE INDEX "StockMovement_purchaseId_idx" ON "StockMovement"("purchaseId");

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "SupplierPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPurchase" ADD CONSTRAINT "SupplierPurchase_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPurchase" ADD CONSTRAINT "SupplierPurchase_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPurchaseItem" ADD CONSTRAINT "SupplierPurchaseItem_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "SupplierPurchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPurchaseItem" ADD CONSTRAINT "SupplierPurchaseItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
