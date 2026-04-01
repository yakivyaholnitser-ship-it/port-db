/* eslint-disable @typescript-eslint/no-require-imports */
const {
  PrismaClient,
  PortFactScope,
  LocationEntityType,
  LocationMatchMethod,
  MatchConfidence,
  LocationMatchStatus,
} = require("@prisma/client");

const prisma = new PrismaClient();

function normalizeLocationName(value) {
  return value.replace(/\s+/g, " ").trim();
}

function canonicalizeLocationKey(value) {
  return normalizeLocationName(value)
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/\bterminals\b/g, " terminal ")
    .replace(/\bterminal\b/g, " ")
    .replace(/\bberths\b/g, " berth ")
    .replace(/\bberth\s+no\.?\s*/g, " berth ")
    .replace(/\bberth\b/g, " ")
    .replace(/\bwharves\b/g, " wharf ")
    .replace(/\belevators\b/g, " elevator ")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isBadLocationName(name) {
  const lower = normalizeLocationName(name).toLowerCase();
  if (!lower) return false;

  return /air draft|aircraft|cargo holds survey|stability calculation|port state control|grain loading equipment|operational hours|minimum depth|height of tide|tide range|bunker fuel sulphur|bunker fuel sulfur|fuel sulphur|fuel sulfur|where bunkering|where the bunkering ops take place|transit time|under keel clearance|water density|load rate|discharge rate|maximum beam|maximum length|max draft|at zero tide|cleaning permitted|draft along side|pipes\s*\d|based on 1 gang|-\s*sulphur$|-\s*sulfur$/i.test(
    lower
  );
}

function parseHint(note) {
  if (!note) return null;
  const text = normalizeLocationName(note).split(";")[0].trim();
  if (!text || isBadLocationName(text)) return null;

  const berthMatch = text.match(/^(.*?)(?:\s*[- ]\s*|\s+)(Berth No\.?\s*\d+[A-Za-z-]*|West Berth|East Berth|North Berth|South Berth)$/i);
  if (berthMatch) {
    return {
      terminalName: berthMatch[1].trim(),
      berthName: berthMatch[2].trim(),
    };
  }

  if (/terminal|wharf|wharves|dock|elevator|elevators/i.test(text)) {
    const terminalName = text.split(/\s*-\s*/)[0].trim();
    if (!terminalName || isBadLocationName(terminalName)) return null;
    return { terminalName, berthName: null };
  }

  return null;
}

async function ensureTerminal(portId, terminalName) {
  if (isBadLocationName(terminalName)) {
    return null;
  }

  const normalizedName = canonicalizeLocationKey(terminalName);
  const existing = await prisma.terminal.findFirst({
    where: { portId, normalizedName },
  });

  if (existing) {
    await prisma.terminalAlias.upsert({
      where: {
        terminalId_normalizedName: {
          terminalId: existing.id,
          normalizedName,
        },
      },
      update: {},
      create: {
        terminalId: existing.id,
        name: terminalName,
        normalizedName,
      },
    });

    return {
      terminal: existing,
      log: {
        entityType: LocationEntityType.TERMINAL,
        rawName: terminalName,
        normalizedName,
        matchedName: existing.name,
        method: LocationMatchMethod.BACKFILL,
        confidence: MatchConfidence.MEDIUM,
        status: LocationMatchStatus.MATCHED,
        reason: "Historical fact matched an existing terminal during global backfill.",
        terminalId: existing.id,
        berthId: null,
      },
    };
  }

  const terminal = await prisma.terminal.create({
    data: {
      portId,
      name: terminalName,
      normalizedName,
      aliases: {
        create: {
          name: terminalName,
          normalizedName,
        },
      },
    },
  });

  return {
    terminal,
    log: {
      entityType: LocationEntityType.TERMINAL,
      rawName: terminalName,
      normalizedName,
      matchedName: terminal.name,
      method: LocationMatchMethod.BACKFILL,
      confidence: MatchConfidence.MEDIUM,
      status: LocationMatchStatus.CREATED_NEW,
      reason: "Global backfill created a terminal from historical fact notes.",
      terminalId: terminal.id,
      berthId: null,
    },
  };
}

async function ensureBerth(portId, terminalId, berthName) {
  if (isBadLocationName(berthName)) {
    return null;
  }

  const normalizedName = canonicalizeLocationKey(berthName);
  const existing = await prisma.berth.findFirst({
    where: { portId, terminalId, normalizedName },
  });

  if (existing) {
    await prisma.berthAlias.upsert({
      where: {
        berthId_normalizedName: {
          berthId: existing.id,
          normalizedName,
        },
      },
      update: {},
      create: {
        berthId: existing.id,
        name: berthName,
        normalizedName,
      },
    });

    return {
      berth: existing,
      log: {
        entityType: LocationEntityType.BERTH,
        rawName: berthName,
        normalizedName,
        matchedName: existing.name,
        method: LocationMatchMethod.BACKFILL,
        confidence: MatchConfidence.MEDIUM,
        status: LocationMatchStatus.MATCHED,
        reason: "Historical fact matched an existing berth during global backfill.",
        terminalId,
        berthId: existing.id,
      },
    };
  }

  const berth = await prisma.berth.create({
    data: {
      portId,
      terminalId,
      name: berthName,
      normalizedName,
      aliases: {
        create: {
          name: berthName,
          normalizedName,
        },
      },
    },
  });

  return {
    berth,
    log: {
      entityType: LocationEntityType.BERTH,
      rawName: berthName,
      normalizedName,
      matchedName: berth.name,
      method: LocationMatchMethod.BACKFILL,
      confidence: MatchConfidence.MEDIUM,
      status: LocationMatchStatus.CREATED_NEW,
      reason: "Global backfill created a berth from historical fact notes.",
      terminalId,
      berthId: berth.id,
    },
  };
}

async function main() {
  const ports = await prisma.port.findMany({
    include: {
      facts: {
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { name: "asc" },
  });

  let updatedFacts = 0;
  let logsCreated = 0;

  for (const port of ports) {
    for (const fact of port.facts) {
      if (!fact.notes || fact.terminalId || fact.berthId) continue;
      const parsed = parseHint(fact.notes);
      if (!parsed?.terminalName) continue;

      const terminalResult = await ensureTerminal(port.id, parsed.terminalName);
      if (!terminalResult) continue;
      const berthResult = parsed.berthName
        ? await ensureBerth(port.id, terminalResult.terminal.id, parsed.berthName)
        : null;

      await prisma.portFact.update({
        where: { id: fact.id },
        data: {
          scope: berthResult ? PortFactScope.BERTH : PortFactScope.TERMINAL,
          terminalId: terminalResult.terminal.id,
          berthId: berthResult?.berth?.id ?? null,
        },
      });

      await prisma.locationMatchLog.createMany({
        data: [terminalResult.log, berthResult?.log]
          .filter(Boolean)
          .map((log) => ({
            ...log,
            portId: port.id,
            sourceRecordId: fact.sourceRecordId ?? null,
          })),
      });

      updatedFacts++;
      logsCreated += berthResult ? 2 : 1;
    }
  }

  console.log(JSON.stringify({ portsProcessed: ports.length, updatedFacts, logsCreated }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
