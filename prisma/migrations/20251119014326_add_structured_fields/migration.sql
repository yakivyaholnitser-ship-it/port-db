-- AlterTable
ALTER TABLE "PortEntry" ADD COLUMN     "bunkeringPlace" TEXT,
ADD COLUMN     "cleaningPermitted" TEXT,
ADD COLUMN     "numberOfGangs" TEXT,
ADD COLUMN     "otherInfo" TEXT,
ADD COLUMN     "productionPerDay" TEXT,
ADD COLUMN     "requiredTrim" TEXT,
ADD COLUMN     "restrictionsJson" TEXT,
ADD COLUMN     "shiftsInfo" TEXT,
ADD COLUMN     "spoutAirDraft" TEXT,
ADD COLUMN     "typeOfCargoesHandled" TEXT,
ADD COLUMN     "waterlineToHatchCoaming" TEXT;
