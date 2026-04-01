BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LocationEntityType') THEN
    CREATE TYPE "LocationEntityType" AS ENUM ('TERMINAL', 'BERTH');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LocationMatchMethod') THEN
    CREATE TYPE "LocationMatchMethod" AS ENUM ('EXACT', 'ALIAS', 'FUZZY', 'AI', 'CREATED_NEW', 'BACKFILL');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MatchConfidence') THEN
    CREATE TYPE "MatchConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LocationMatchStatus') THEN
    CREATE TYPE "LocationMatchStatus" AS ENUM ('MATCHED', 'CREATED_NEW', 'NEEDS_REVIEW');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "LocationMatchLog" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "entityType" "LocationEntityType" NOT NULL,
  "rawName" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "matchedName" TEXT,
  "method" "LocationMatchMethod" NOT NULL,
  "confidence" "MatchConfidence" NOT NULL,
  "status" "LocationMatchStatus" NOT NULL,
  "reason" TEXT,
  "portId" INTEGER NOT NULL REFERENCES "Port"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "terminalId" INTEGER REFERENCES "Terminal"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "berthId" INTEGER REFERENCES "Berth"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sourceRecordId" INTEGER REFERENCES "SourceRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "LocationMatchLog_portId_createdAt_idx"
  ON "LocationMatchLog"("portId", "createdAt");

CREATE INDEX IF NOT EXISTS "LocationMatchLog_status_confidence_idx"
  ON "LocationMatchLog"("status", "confidence");

CREATE INDEX IF NOT EXISTS "LocationMatchLog_sourceRecordId_idx"
  ON "LocationMatchLog"("sourceRecordId");

COMMIT;
