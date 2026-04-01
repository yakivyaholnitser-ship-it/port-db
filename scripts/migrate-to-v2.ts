import { PortFactScope } from "@prisma/client";
import { prisma } from "../lib/prisma";

function normalizePortName(value: string): string {
  return value
    .replace(/\s*\([^)]*\)\s*$/i, "")
    .replace(/\b(Port of|Port)\s+/i, "")
    .replace(/\s+Port$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  return value.replace(/\s+/g, " ").trim();
}

type LegacyFact = {
  category?: string;
  value?: string;
  unit?: string | null;
  note?: string | null;
  notes?: string | null;
  rawSnippet?: string | null;
};

async function main() {
  console.log("Clearing hierarchical port intelligence tables...");
  await prisma.portFact.deleteMany();
  await prisma.sourceRecord.deleteMany();
  await prisma.berth.deleteMany();
  await prisma.terminal.deleteMany();
  await prisma.port.deleteMany();

  const entries = await prisma.portEntry.findMany({ orderBy: { createdAt: "asc" } });
  console.log(`Found ${entries.length} legacy PortEntry rows.`);

  for (const entry of entries) {
    const normalizedPortName = normalizePortName(entry.port);
    const terminalName = normalizeName(entry.terminal);

    const existingPort = await prisma.port.findFirst({
      where: {
        normalizedName: normalizedPortName,
        country: entry.country ?? null,
      },
    });

    const port = existingPort
      ? await prisma.port.update({
          where: { id: existingPort.id },
          data: {
            lat: existingPort.lat ?? entry.lat ?? null,
            lon: existingPort.lon ?? entry.lon ?? null,
          },
        })
      : await prisma.port.create({
          data: {
            name: normalizedPortName,
            normalizedName: normalizedPortName,
            country: entry.country ?? null,
            lat: entry.lat ?? null,
            lon: entry.lon ?? null,
          },
        });

    const terminal = terminalName
      ? await prisma.terminal.upsert({
          where: {
            portId_normalizedName: {
              portId: port.id,
              normalizedName: terminalName.toLowerCase(),
            },
          },
          update: {},
          create: {
            portId: port.id,
            name: terminalName,
            normalizedName: terminalName.toLowerCase(),
          },
        })
      : null;

    const sourceRecord = await prisma.sourceRecord.create({
      data: {
        sourceName: entry.dataSource ?? null,
        sourceDate: entry.sourceDate ?? null,
        rawText: entry.rawText,
        portId: port.id,
        terminalId: terminal?.id ?? null,
      },
    });

    const facts: Array<{
      category: string;
      value: string;
      unit?: string | null;
      notes?: string | null;
      rawSnippet?: string | null;
      scope: PortFactScope;
    }> = [];

    const pushFact = (
      value: string | null | undefined,
      category: string,
      unit?: string | null,
      notes?: string | null
    ) => {
      if (!value?.trim()) return;
      facts.push({
        category,
        value: value.trim(),
        unit: unit ?? null,
        notes: notes ?? null,
        scope: terminal ? PortFactScope.TERMINAL : PortFactScope.PORT,
      });
    };

    pushFact(entry.maxDraftMeters, "draft", "m", entry.maxDraftNotes);
    pushFact(entry.waterDensity, "density");
    pushFact(entry.loadRatePerDayMt, "load_rate", "MT/day");
    pushFact(entry.dischargeRatePerDayMt, "discharge_rate", "MT/day");
    pushFact(entry.productionPerDay, "production", "MT/day");
    pushFact(entry.numberOfGangs, "gangs");
    pushFact(entry.shiftsInfo, "shifts");
    pushFact(entry.equipmentUsed, "equipment");
    pushFact(entry.cargo, "cargo");
    pushFact(entry.loaMeters, "loa", "m");
    pushFact(entry.beamMeters, "beam", "m");
    pushFact(entry.maxDwtMt, "dwt", "MT");
    pushFact(entry.airDraftMeters, "air_draft", "m");
    pushFact(entry.requiredTrim, "trim");
    pushFact(entry.transitPsNotes, "transit");
    pushFact(entry.bunkeringPlace, "bunker");
    pushFact(entry.cleaningPermitted, "cleaning");
    pushFact(entry.sulphurLimit, "sulphur");
    pushFact(entry.specialRestrictions, "restriction");
    pushFact(entry.otherInfo, "other");

    if (entry.factsJson) {
      try {
        const parsed = JSON.parse(entry.factsJson) as LegacyFact[];
        for (const fact of parsed) {
          if (!fact?.category || !fact?.value) continue;
          facts.push({
            category: fact.category,
            value: fact.value,
            unit: fact.unit ?? null,
            notes: fact.notes ?? fact.note ?? null,
            rawSnippet: fact.rawSnippet ?? null,
            scope: terminal ? PortFactScope.TERMINAL : PortFactScope.PORT,
          });
        }
      } catch {
        // Ignore malformed legacy JSON.
      }
    }

    if (facts.length > 0) {
      await prisma.portFact.createMany({
        data: facts.map((fact) => ({
          scope: fact.scope,
          category: fact.category,
          value: fact.value,
          unit: fact.unit ?? null,
          notes: fact.notes ?? null,
          rawSnippet: fact.rawSnippet ?? null,
          portId: port.id,
          terminalId: terminal?.id ?? null,
          berthId: null,
          sourceRecordId: sourceRecord.id,
        })),
      });
    }
  }

  console.log("Legacy migration complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
