/*
  Warnings:

  - You are about to drop the column `portId` on the `PortEntry` table. All the data in the column will be lost.
  - You are about to drop the column `terminalId` on the `PortEntry` table. All the data in the column will be lost.
  - You are about to drop the `Port` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Terminal` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "PortEntry" DROP CONSTRAINT "PortEntry_portId_fkey";

-- DropForeignKey
ALTER TABLE "PortEntry" DROP CONSTRAINT "PortEntry_terminalId_fkey";

-- DropForeignKey
ALTER TABLE "Terminal" DROP CONSTRAINT "Terminal_portId_fkey";

-- DropIndex
DROP INDEX "PortEntry_portId_idx";

-- DropIndex
DROP INDEX "PortEntry_terminalId_idx";

-- AlterTable
ALTER TABLE "PortEntry" DROP COLUMN "portId",
DROP COLUMN "terminalId",
ADD COLUMN     "lat" DOUBLE PRECISION,
ADD COLUMN     "lon" DOUBLE PRECISION;

-- DropTable
DROP TABLE "Port";

-- DropTable
DROP TABLE "Terminal";
