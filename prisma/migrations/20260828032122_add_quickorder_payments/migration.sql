-- CreateTable
CREATE TABLE "QuickOrderPayment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'cash',
    "note" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuickOrderPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuickOrderPayment_orderId_createdAt_idx" ON "QuickOrderPayment"("orderId", "createdAt");

-- AddForeignKey
ALTER TABLE "QuickOrderPayment" ADD CONSTRAINT "QuickOrderPayment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "QuickOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickOrderPayment" ADD CONSTRAINT "QuickOrderPayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
