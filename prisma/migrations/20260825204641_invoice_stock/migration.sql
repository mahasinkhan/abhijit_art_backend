-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "stockApplied" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "invoiceId" TEXT;

-- CreateIndex
CREATE INDEX "StockMovement_invoiceId_idx" ON "StockMovement"("invoiceId");

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
