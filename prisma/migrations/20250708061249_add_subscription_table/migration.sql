-- CreateTable
CREATE TABLE "subscription" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "subPlan" TEXT NOT NULL,
    "subSlot" INTEGER NOT NULL,
    "subRemSlot" INTEGER NOT NULL,
    "subDuration" INTEGER NOT NULL,
    "subAmount" INTEGER NOT NULL,
    "subEmail" TEXT NOT NULL,
    "subPassword" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "subId" TEXT NOT NULL,
    "subCategory" TEXT NOT NULL,
    "subSubCategory" TEXT NOT NULL,
    "crew" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_subId_key" ON "subscription"("subId");
