let prisma;

const FIXTURES = [
  {
    sourceName: "Condition Fixture",
    sourceDate: "2026-03-30",
    rawText: "LB214 max draft 12.8m FW at Long Beach",
    port: "Long Beach",
    terminal: "LB214",
    berth: null,
    fact: {
      scope: "TERMINAL",
      category: "draft",
      value: "12.8",
      unit: "m",
      notes: "FW",
    },
  },
  {
    sourceName: "Condition Fixture",
    sourceDate: "2026-03-31",
    rawText: "LB214 max draft 13.1m SW at Long Beach",
    port: "Long Beach",
    terminal: "LB214",
    berth: null,
    fact: {
      scope: "TERMINAL",
      category: "draft",
      value: "13.1",
      unit: "m",
      notes: "SW",
    },
  },
  {
    sourceName: "Condition Fixture",
    sourceDate: "2026-03-30",
    rawText: "Pacific Elevators berth no. 4 draft 13.2m at zero tide Vancouver",
    port: "Vancouver",
    terminal: "Pacific Elevators",
    berth: "Berth No. 4",
    fact: {
      scope: "BERTH",
      category: "draft",
      value: "13.2",
      unit: "m",
      notes: "at zero tide",
    },
  },
  {
    sourceName: "Condition Fixture",
    sourceDate: "2026-03-30",
    rawText: "Ningbo CT3 draft 14.5m density 1.025",
    port: "Ningbo",
    terminal: "CT3",
    berth: null,
    fact: {
      scope: "TERMINAL",
      category: "draft",
      value: "14.5",
      unit: "m",
      notes: "density 1.025",
    },
  },
  {
    sourceName: "Condition Fixture",
    sourceDate: "2026-03-30",
    rawText: "Majishan 3# berth draft 15.0m +/- tide",
    port: "Majishan",
    terminal: "Ore Jetty",
    berth: "3# Berth",
    fact: {
      scope: "BERTH",
      category: "draft",
      value: "15.0",
      unit: "m",
      notes: "+/- tide",
    },
  },
  {
    sourceName: "Condition Fixture",
    sourceDate: "2026-03-30",
    rawText: "Kandla oil jetty no.7 arrival draft 11.5m",
    port: "Kandla",
    terminal: "Oil Jetty",
    berth: "Jetty No. 7",
    fact: {
      scope: "BERTH",
      category: "draft",
      value: "11.5",
      unit: "m",
      notes: "arrival",
    },
  },
  {
    sourceName: "Condition Fixture",
    sourceDate: "2026-03-31",
    rawText: "Kandla oil jetty no.7 departure draft 11.8m",
    port: "Kandla",
    terminal: "Oil Jetty",
    berth: "Jetty No. 7",
    fact: {
      scope: "BERTH",
      category: "draft",
      value: "11.8",
      unit: "m",
      notes: "departure",
    },
  },
  {
    sourceName: "Condition Fixture",
    sourceDate: "2026-03-30",
    rawText: "Mesaieed berth A max draft 12.8m HW only",
    port: "Mesaieed",
    terminal: "Main Terminal",
    berth: "Berth A",
    fact: {
      scope: "BERTH",
      category: "draft",
      value: "12.8",
      unit: "m",
      notes: "HW only",
    },
  },
  {
    sourceName: "Condition Fixture",
    sourceDate: "2026-03-30",
    rawText: "Piraeus terminal II berth 3 draft 11.9m LW",
    port: "Piraeus",
    terminal: "Terminal II",
    berth: "Berth 3",
    fact: {
      scope: "BERTH",
      category: "draft",
      value: "11.9",
      unit: "m",
      notes: "LW",
    },
  },
  {
    sourceName: "Condition Fixture",
    sourceDate: "2026-03-30",
    rawText: "Santos T-Granel berth 2 draft 12.4m in brackish water",
    port: "Santos",
    terminal: "T-Granel",
    berth: "Berth 2",
    fact: {
      scope: "BERTH",
      category: "draft",
      value: "12.4",
      unit: "m",
      notes: "in brackish water",
    },
  },
  {
    sourceName: "Condition Fixture",
    sourceDate: "2026-03-30",
    rawText: "Richards Bay CT berth 203 draft 16.0m NAABSA",
    port: "Richards Bay",
    terminal: "CT",
    berth: "Berth 203",
    fact: {
      scope: "BERTH",
      category: "draft",
      value: "16.0",
      unit: "m",
      notes: "NAABSA",
    },
  },
  {
    sourceName: "Condition Fixture",
    sourceDate: "2026-03-30",
    rawText: "Jebel Ali CT2 berth 5 mooring available via SBM",
    port: "Jebel Ali",
    terminal: "CT2",
    berth: "Berth 5",
    fact: {
      scope: "BERTH",
      category: "other",
      value: "Mooring available",
      unit: null,
      notes: "via SBM",
    },
  },
  {
    sourceName: "Condition Fixture",
    sourceDate: "2026-03-30",
    rawText: "Hay Point CT7 export line connected via SPM",
    port: "Hay Point",
    terminal: "CT7",
    berth: null,
    fact: {
      scope: "TERMINAL",
      category: "other",
      value: "export line",
      unit: null,
      notes: "connected via SPM",
    },
  },
  {
    sourceName: "Condition Fixture",
    sourceDate: "2026-03-30",
    rawText: "Ningbo CT3 offshore support through CBM",
    port: "Ningbo",
    terminal: "CT3",
    berth: null,
    fact: {
      scope: "TERMINAL",
      category: "other",
      value: "offshore support",
      unit: null,
      notes: "through CBM",
    },
  },
];

async function findPort(name) {
  return prisma.port.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });
}

async function findTerminal(portId, name) {
  if (!name) return null;
  return prisma.terminal.findFirst({
    where: {
      portId,
      name: { equals: name, mode: "insensitive" },
    },
  });
}

async function findBerth(portId, terminalId, name) {
  if (!name) return null;
  return prisma.berth.findFirst({
    where: {
      portId,
      terminalId: terminalId ?? null,
      name: { equals: name, mode: "insensitive" },
    },
  });
}

async function upsertFixture(fixture) {
  const port = await findPort(fixture.port);
  if (!port) throw new Error(`Port not found: ${fixture.port}`);

  const terminal = await findTerminal(port.id, fixture.terminal);
  if (fixture.terminal && !terminal) {
    throw new Error(`Terminal not found for ${fixture.port}: ${fixture.terminal}`);
  }

  const berth = await findBerth(port.id, terminal?.id ?? null, fixture.berth);
  if (fixture.berth && !berth) {
    throw new Error(`Berth not found for ${fixture.port}: ${fixture.berth}`);
  }

  const existing = await prisma.sourceRecord.findFirst({
    where: {
      sourceName: fixture.sourceName,
      rawText: fixture.rawText,
      portId: port.id,
    },
  });

  const sourceRecord = existing
    ? await prisma.sourceRecord.update({
        where: { id: existing.id },
        data: {
          sourceDate: new Date(fixture.sourceDate),
          terminalId: terminal?.id ?? null,
          berthId: berth?.id ?? null,
        },
      })
    : await prisma.sourceRecord.create({
        data: {
          sourceName: fixture.sourceName,
          sourceDate: new Date(fixture.sourceDate),
          rawText: fixture.rawText,
          portId: port.id,
          terminalId: terminal?.id ?? null,
          berthId: berth?.id ?? null,
        },
      });

  const existingFact = await prisma.portFact.findFirst({
    where: {
      sourceRecordId: sourceRecord.id,
      category: fixture.fact.category,
      value: fixture.fact.value,
    },
  });

  if (existingFact) {
    await prisma.portFact.update({
      where: { id: existingFact.id },
      data: {
        scope: fixture.fact.scope,
        unit: fixture.fact.unit,
        notes: fixture.fact.notes,
        portId: port.id,
        terminalId: terminal?.id ?? null,
        berthId: berth?.id ?? null,
      },
    });
    return;
  }

  await prisma.portFact.create({
    data: {
      scope: fixture.fact.scope,
      category: fixture.fact.category,
      value: fixture.fact.value,
      unit: fixture.fact.unit,
      notes: fixture.fact.notes,
      portId: port.id,
      terminalId: terminal?.id ?? null,
      berthId: berth?.id ?? null,
      sourceRecordId: sourceRecord.id,
    },
  });
}

async function main() {
  const { PrismaClient } = await import("@prisma/client");
  prisma = new PrismaClient();

  try {
    for (const fixture of FIXTURES) {
      await upsertFixture(fixture);
    }

    console.log(`Seeded ${FIXTURES.length} global condition fixture facts.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
