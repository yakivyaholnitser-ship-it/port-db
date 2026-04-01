BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PortFactScope') THEN
    CREATE TYPE "PortFactScope" AS ENUM ('PORT', 'TERMINAL', 'BERTH');
  END IF;
END $$;

ALTER TABLE "Port"
  ADD COLUMN IF NOT EXISTS "normalizedName" TEXT;

UPDATE "Port"
SET "normalizedName" = TRIM("name")
WHERE "normalizedName" IS NULL;

ALTER TABLE "Port"
  ALTER COLUMN "normalizedName" SET NOT NULL;

DROP INDEX IF EXISTS "Port_name_country_key";

CREATE UNIQUE INDEX IF NOT EXISTS "Port_normalizedName_country_key"
  ON "Port"("normalizedName", "country");

CREATE TABLE IF NOT EXISTS "Terminal" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "lat" DOUBLE PRECISION,
  "lon" DOUBLE PRECISION,
  "portId" INTEGER NOT NULL REFERENCES "Port"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "Terminal_portId_normalizedName_key"
  ON "Terminal"("portId", "normalizedName");

CREATE TABLE IF NOT EXISTS "Berth" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "lat" DOUBLE PRECISION,
  "lon" DOUBLE PRECISION,
  "portId" INTEGER NOT NULL REFERENCES "Port"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "terminalId" INTEGER REFERENCES "Terminal"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "Berth_portId_idx"
  ON "Berth"("portId");

CREATE UNIQUE INDEX IF NOT EXISTS "Berth_terminalId_normalizedName_key"
  ON "Berth"("terminalId", "normalizedName");

CREATE TABLE IF NOT EXISTS "SourceRecord" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceName" TEXT,
  "sourceDate" TIMESTAMP(3),
  "rawText" TEXT NOT NULL,
  "portId" INTEGER NOT NULL REFERENCES "Port"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "terminalId" INTEGER REFERENCES "Terminal"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "berthId" INTEGER REFERENCES "Berth"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "legacyFactId" INTEGER
);

CREATE INDEX IF NOT EXISTS "SourceRecord_portId_sourceDate_idx"
  ON "SourceRecord"("portId", "sourceDate");

CREATE INDEX IF NOT EXISTS "SourceRecord_terminalId_sourceDate_idx"
  ON "SourceRecord"("terminalId", "sourceDate");

CREATE INDEX IF NOT EXISTS "SourceRecord_berthId_sourceDate_idx"
  ON "SourceRecord"("berthId", "sourceDate");

ALTER TABLE "PortFact"
  ADD COLUMN IF NOT EXISTS "scope" "PortFactScope";

ALTER TABLE "PortFact"
  ADD COLUMN IF NOT EXISTS "terminalId" INTEGER;

ALTER TABLE "PortFact"
  ADD COLUMN IF NOT EXISTS "berthId" INTEGER;

ALTER TABLE "PortFact"
  ADD COLUMN IF NOT EXISTS "sourceRecordId" INTEGER;

UPDATE "PortFact"
SET "scope" = 'PORT'
WHERE "scope" IS NULL;

INSERT INTO "SourceRecord" (
  "createdAt",
  "sourceName",
  "sourceDate",
  "rawText",
  "portId",
  "legacyFactId"
)
SELECT
  pf."createdAt",
  pf."source",
  pf."sourceDate",
  COALESCE(
    pf."rawSnippet",
    pf."category" || ': ' || pf."value" || COALESCE(' ' || pf."unit", '')
  ),
  pf."portId",
  pf."id"
FROM "PortFact" pf
LEFT JOIN "SourceRecord" sr ON sr."legacyFactId" = pf."id"
WHERE sr."id" IS NULL;

UPDATE "PortFact" pf
SET "sourceRecordId" = sr."id"
FROM "SourceRecord" sr
WHERE sr."legacyFactId" = pf."id"
  AND pf."sourceRecordId" IS NULL;

ALTER TABLE "PortFact"
  ALTER COLUMN "scope" SET NOT NULL;

ALTER TABLE "PortFact"
  ALTER COLUMN "sourceRecordId" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PortFact_terminalId_fkey'
  ) THEN
    ALTER TABLE "PortFact"
      ADD CONSTRAINT "PortFact_terminalId_fkey"
      FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PortFact_berthId_fkey'
  ) THEN
    ALTER TABLE "PortFact"
      ADD CONSTRAINT "PortFact_berthId_fkey"
      FOREIGN KEY ("berthId") REFERENCES "Berth"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PortFact_sourceRecordId_fkey'
  ) THEN
    ALTER TABLE "PortFact"
      ADD CONSTRAINT "PortFact_sourceRecordId_fkey"
      FOREIGN KEY ("sourceRecordId") REFERENCES "SourceRecord"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "PortFact_portId_category_idx"
  ON "PortFact"("portId", "category");

CREATE INDEX IF NOT EXISTS "PortFact_terminalId_category_idx"
  ON "PortFact"("terminalId", "category");

CREATE INDEX IF NOT EXISTS "PortFact_berthId_category_idx"
  ON "PortFact"("berthId", "category");

CREATE INDEX IF NOT EXISTS "PortFact_sourceRecordId_idx"
  ON "PortFact"("sourceRecordId");

ALTER TABLE "SourceRecord"
  DROP COLUMN IF EXISTS "legacyFactId";

COMMIT;
