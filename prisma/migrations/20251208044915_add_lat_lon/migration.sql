-- AlterTable
ALTER TABLE "PortEntry" ADD COLUMN     "equipmentUsed" TEXT,
ADD COLUMN     "lat" DOUBLE PRECISION,
ADD COLUMN     "lon" DOUBLE PRECISION,
ADD COLUMN     "shiftsPerDay" TEXT;
