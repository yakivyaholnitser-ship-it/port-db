-- 1) Create Port table
CREATE TABLE "Port" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "name" TEXT NOT NULL,
  "country" TEXT,
  "lat" DOUBLE PRECISION,
  "lon" DOUBLE PRECISION
);

-- unique(name, country)
CREATE UNIQUE INDEX "Port_name_country_key" ON "Port" ("name", "country");
CREATE INDEX "Port_country_idx" ON "Port" ("country");

-- 2) Create Terminal table
CREATE TABLE "Terminal" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "name" TEXT NOT NULL,
  "portId" INTEGER NOT NULL
);

CREATE UNIQUE INDEX "Terminal_portId_name_key" ON "Terminal" ("portId", "name");

ALTER TABLE "Terminal"
ADD CONSTRAINT "Terminal_portId_fkey"
FOREIGN KEY ("portId") REFERENCES "Port"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- 3) Add nullable columns to PortEntry first
ALTER TABLE "PortEntry"
ADD COLUMN "portId" INTEGER,
ADD COLUMN "terminalId" INTEGER;

-- 4) Backfill Port rows from existing PortEntry
-- Use MAX(lat/lon) to pick any known coordinates from existing rows
INSERT INTO "Port" ("name", "country", "lat", "lon")
SELECT
  pe."port" AS name,
  pe."country" AS country,
  MAX(pe."lat") AS lat,
  MAX(pe."lon") AS lon
FROM "PortEntry" pe
GROUP BY pe."port", pe."country";

-- 5) Backfill PortEntry.portId
UPDATE "PortEntry" pe
SET "portId" = p."id"
FROM "Port" p
WHERE p."name" = pe."port"
  AND p."country" IS NOT DISTINCT FROM pe."country";

-- Safety check: if still NULL (shouldn't happen), map to UNKNOWN_PORT
-- (creates UNKNOWN_PORT row if not exists)
INSERT INTO "Port" ("name", "country")
SELECT 'UNKNOWN_PORT', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM "Port" WHERE "name"='UNKNOWN_PORT' AND "country" IS NULL
);

UPDATE "PortEntry"
SET "portId" = (SELECT "id" FROM "Port" WHERE "name"='UNKNOWN_PORT' AND "country" IS NULL)
WHERE "portId" IS NULL;

-- 6) Create Terminal rows (only meaningful ones)
INSERT INTO "Terminal" ("name", "portId")
SELECT DISTINCT
  pe."terminal" AS name,
  pe."portId"   AS portId
FROM "PortEntry" pe
WHERE pe."terminal" IS NOT NULL
  AND pe."terminal" <> ''
  AND pe."terminal" <> 'UNKNOWN_TERMINAL';

-- 7) Backfill PortEntry.terminalId
UPDATE "PortEntry" pe
SET "terminalId" = t."id"
FROM "Terminal" t
WHERE t."portId" = pe."portId"
  AND t."name" = pe."terminal";

-- 8) Make portId required + add FKs
ALTER TABLE "PortEntry"
ALTER COLUMN "portId" SET NOT NULL;

ALTER TABLE "PortEntry"
ADD CONSTRAINT "PortEntry_portId_fkey"
FOREIGN KEY ("portId") REFERENCES "Port"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PortEntry"
ADD CONSTRAINT "PortEntry_terminalId_fkey"
FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- 9) Indexes for performance
CREATE INDEX "PortEntry_portId_idx" ON "PortEntry" ("portId");
CREATE INDEX "PortEntry_terminalId_idx" ON "PortEntry" ("terminalId");
CREATE INDEX "PortEntry_operation_idx" ON "PortEntry" ("operation");