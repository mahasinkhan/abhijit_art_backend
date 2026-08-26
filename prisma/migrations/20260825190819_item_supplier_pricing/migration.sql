-- CreateTable
CREATE TABLE "ItemSupplier" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "supplierSku" TEXT NOT NULL DEFAULT '',
    "preferred" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT NOT NULL DEFAULT '',
    "lastRate" DECIMAL(12,2),
    "lastPurchaseAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemSupplier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ItemSupplier_itemId_idx" ON "ItemSupplier"("itemId");

-- CreateIndex
CREATE INDEX "ItemSupplier_supplierId_idx" ON "ItemSupplier"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemSupplier_itemId_supplierId_key" ON "ItemSupplier"("itemId", "supplierId");

-- AddForeignKey
ALTER TABLE "ItemSupplier" ADD CONSTRAINT "ItemSupplier_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemSupplier" ADD CONSTRAINT "ItemSupplier_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
