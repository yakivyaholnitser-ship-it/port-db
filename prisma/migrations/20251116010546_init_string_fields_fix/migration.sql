-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PortEntry" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "port" TEXT NOT NULL,
    "country" TEXT,
    "terminal" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "cargo" TEXT,
    "stowFactor" TEXT,
    "quantityInfo" TEXT,
    "waterDensity" TEXT,
    "maxDraftMeters" TEXT,
    "maxDraftNotes" TEXT,
    "loaMeters" TEXT,
    "beamMeters" TEXT,
    "maxDwtMt" TEXT,
    "airDraftMeters" TEXT,
    "minFreeboardMeters" TEXT,
    "loadRatePerDayMt" TEXT,
    "dischargeRatePerDayMt" TEXT,
    "agents" TEXT,
    "costDockage" TEXT,
    "costPilotage" TEXT,
    "costTowage" TEXT,
    "costTotalEstimate" TEXT,
    "bunkeringNotes" TEXT,
    "cleaningNotes" TEXT,
    "transitPsNotes" TEXT,
    "sulphurLimit" TEXT,
    "specialRestrictions" TEXT,
    "rawText" TEXT NOT NULL
);
INSERT INTO "new_PortEntry" ("agents", "airDraftMeters", "beamMeters", "bunkeringNotes", "cargo", "cleaningNotes", "costDockage", "costPilotage", "costTotalEstimate", "costTowage", "country", "createdAt", "dischargeRatePerDayMt", "id", "loaMeters", "loadRatePerDayMt", "maxDraftMeters", "maxDraftNotes", "maxDwtMt", "minFreeboardMeters", "operation", "port", "quantityInfo", "rawText", "specialRestrictions", "stowFactor", "sulphurLimit", "terminal", "transitPsNotes", "waterDensity") SELECT "agents", "airDraftMeters", "beamMeters", "bunkeringNotes", "cargo", "cleaningNotes", "costDockage", "costPilotage", "costTotalEstimate", "costTowage", "country", "createdAt", "dischargeRatePerDayMt", "id", "loaMeters", "loadRatePerDayMt", "maxDraftMeters", "maxDraftNotes", "maxDwtMt", "minFreeboardMeters", "operation", "port", "quantityInfo", "rawText", "specialRestrictions", "stowFactor", "sulphurLimit", "terminal", "transitPsNotes", "waterDensity" FROM "PortEntry";
DROP TABLE "PortEntry";
ALTER TABLE "new_PortEntry" RENAME TO "PortEntry";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
