BEGIN;

CREATE TABLE IF NOT EXISTS "TerminalAlias" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "terminalId" INTEGER NOT NULL REFERENCES "Terminal"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "TerminalAlias_normalizedName_idx"
  ON "TerminalAlias"("normalizedName");

CREATE UNIQUE INDEX IF NOT EXISTS "TerminalAlias_terminalId_normalizedName_key"
  ON "TerminalAlias"("terminalId", "normalizedName");

CREATE TABLE IF NOT EXISTS "BerthAlias" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "berthId" INTEGER NOT NULL REFERENCES "Berth"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "BerthAlias_normalizedName_idx"
  ON "BerthAlias"("normalizedName");

CREATE UNIQUE INDEX IF NOT EXISTS "BerthAlias_berthId_normalizedName_key"
  ON "BerthAlias"("berthId", "normalizedName");

INSERT INTO "TerminalAlias" ("name", "normalizedName", "terminalId")
SELECT t."name", t."normalizedName", t."id"
FROM "Terminal" t
LEFT JOIN "TerminalAlias" ta
  ON ta."terminalId" = t."id"
 AND ta."normalizedName" = t."normalizedName"
WHERE ta."id" IS NULL;

INSERT INTO "BerthAlias" ("name", "normalizedName", "berthId")
SELECT b."name", b."normalizedName", b."id"
FROM "Berth" b
LEFT JOIN "BerthAlias" ba
  ON ba."berthId" = b."id"
 AND ba."normalizedName" = b."normalizedName"
WHERE ba."id" IS NULL;

COMMIT;
