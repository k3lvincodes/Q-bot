-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "fullName" TEXT,
    "email" TEXT,
    "platform" TEXT NOT NULL,
    "admin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_userId_key" ON "users"("userId");
