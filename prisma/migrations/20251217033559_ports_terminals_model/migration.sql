/*
  Warnings:

  - You are about to drop the column `lat` on the `PortEntry` table. All the data in the column will be lost.
  - You are about to drop the column `lon` on the `PortEntry` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[name,portId]` on the table `Terminal` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "PortEntry" DROP CONSTRAINT "PortEntry_portId_fkey";

-- DropForeignKey
ALTER TABLE "Terminal" DROP CONSTRAINT "Terminal_portId_fkey";

-- DropIndex
DROP INDEX "Port_country_idx";

-- DropIndex
DROP INDEX "PortEntry_operation_idx";

-- DropIndex
DROP INDEX "Terminal_portId_name_key";

-- AlterTable
ALTER TABLE "Port" ADD COLUMN     "updatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PortEntry" DROP COLUMN "lat",
DROP COLUMN "lon",
ALTER COLUMN "portId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Terminal" ADD COLUMN     "updatedAt" TIMESTAMP(3),
ALTER COLUMN "portId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Terminal_portId_idx" ON "Terminal"("portId");

-- CreateIndex
CREATE UNIQUE INDEX "Terminal_name_portId_key" ON "Terminal"("name", "portId");

-- AddForeignKey
ALTER TABLE "Terminal" ADD CONSTRAINT "Terminal_portId_fkey" FOREIGN KEY ("portId") REFERENCES "Port"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortEntry" ADD CONSTRAINT "PortEntry_portId_fkey" FOREIGN KEY ("portId") REFERENCES "Port"("id") ON DELETE SET NULL ON UPDATE CASCADE;
