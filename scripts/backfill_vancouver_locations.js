/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient, PortFactScope } = require("@prisma/client");

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

function tokenSet(value) {
  return new Set(
    canonicalizeLocationKey(value)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean)
  );
}

function jaccardSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function matchByAlias(rawName, candidates, minimumScore = 0.74) {
  const rawKey = canonicalizeLocationKey(rawName);
  if (!rawKey) return null;

  for (const candidate of candidates) {
    if (candidate.normalizedName === rawKey) return candidate;
    if (candidate.aliases?.some((alias) => alias.normalizedName === rawKey)) {
      return candidate;
    }
  }

  const rawTokens = tokenSet(rawName);
  let best = null;

  for (const candidate of candidates) {
    const keys = [
      candidate.normalizedName,
      ...(candidate.aliases?.map((alias) => alias.normalizedName) ?? []),
    ];

    for (const key of keys) {
      const score = jaccardSimilarity(rawTokens, tokenSet(key));
      if (!best || score > best.score) {
        best = { candidate, score };
      }
    }
  }

  return best && best.score >= minimumScore ? best.candidate : null;
}

function titleCaseBerth(value) {
  return value
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/No\.\s*(\d+)/g, "No. $1");
}

function normalizeTerminalDisplayName(value) {
  return value
    .replace(/\bPacific Elevator\b/i, "Pacific Elevators")
    .replace(/\bPacific Elevators\b/i, "Pacific Elevators")
    .replace(/\bG3\b$/i, "G3 Terminal")
    .replace(/\bCascadia\b$/i, "Cascadia Terminal")
    .replace(/\bPembina Vancouver Wharves No\.?\s*1\b/i, "Vancouver Wharves (Pembina)")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isBadLocationText(text) {
  return /air draft|aircraft|cargo holds survey|stability calculation|port state control|grain loading equipment|operational hours|minimum depth|height of tide|tide range|bunker fuel sulphur|bunker fuel sulfur|fuel sulphur|fuel sulfur|where bunkering|where the bunkering ops take place|transit time|under keel clearance|water density|load rate|discharge rate|maximum beam|maximum length|max draft|at zero tide|cleaning permitted|pipes\s*\d|draft along side/i.test(
    text
  );
}

function parseLocationHint(note) {
  if (!note) return null;
  let text = normalizeLocationName(note).split(";")[0].trim();
  if (!text) return null;
  if (isBadLocationText(text)) return null;

  text = text.replace(/\s*\(based on[^)]*\)\s*$/i, "").trim();
  text = text.replace(/\s*-\s*Grain terminal\s*$/i, "").trim();
  text = text.replace(/\s*-\s*Sulphur\s*$/i, "").trim();

  const commodityTail = /\s*-\s*(Barley\s*\/\s*Grain|Grain|Potash|Copper Concentrates)\s*$/i;
  text = text.replace(commodityTail, "").trim();
  text = text.replace(/\s*\((Hudbay|Jan\s+\d{4}|Viterra)\)\s*$/i, "").trim();
  text = text.replace(/\s+\bLOA\b.*$/i, "").trim();
  text = text.replace(/\s+\bmax\s*DWT\b.*$/i, "").trim();

  const westEast = text.match(/^(.*?)(?:\s+(West and East berth|East and West berth))$/i);
  if (westEast) {
    return {
      terminalName: normalizeTerminalDisplayName(westEast[1].trim()),
      berthNames: ["West Berth", "East Berth"],
    };
  }

  const berthNo = text.match(/^(.*?)(?:\s*[- ]\s*|\s+)(Berth No\.?\s*\d+[A-Za-z-]*)$/i);
  if (berthNo) {
    return {
      terminalName: normalizeTerminalDisplayName(berthNo[1].trim()),
      berthNames: [titleCaseBerth(berthNo[2].trim())],
    };
  }

  const directionalBerth = text.match(/^(.*?)(?:\s+)(West Berth|East Berth|North Berth|South Berth)$/i);
  if (directionalBerth) {
    return {
      terminalName: normalizeTerminalDisplayName(directionalBerth[1].trim()),
      berthNames: [titleCaseBerth(directionalBerth[2].trim())],
    };
  }

  const fraserDock = text.match(/^(Fraser Surrey Dock)\s+(Berth No\.?\s*\d+)$/i);
  if (fraserDock) {
    return {
      terminalName: normalizeTerminalDisplayName(fraserDock[1].trim()),
      berthNames: [titleCaseBerth(fraserDock[2].trim())],
    };
  }

  if (/^(Cascadia|G3|Pacific Elevators?|Alliance Grain Terminal \(AGT\)|Pacific Coast Terminals)$/i.test(text)) {
    return {
      terminalName: normalizeTerminalDisplayName(text),
      berthNames: [],
    };
  }

  if (/^(Vancouver Wharves \(Pembina\)|Pembina Vancouver Wharves No\.?\s*1)$/i.test(text)) {
    return {
      terminalName: "Vancouver Wharves (Pembina)",
      berthNames: text.match(/No\.?\s*1/i) ? ["Berth No. 1"] : [],
    };
  }

  if (/^(Pacific Elevators?|Cascadia|Alliance Grain Terminal \(AGT\)|G3|Pacific Coast Terminals)\b/i.test(text)) {
    return {
      terminalName: normalizeTerminalDisplayName(text.split(/\s*-\s*/)[0].trim()),
      berthNames: [],
    };
  }

  return null;
}

async function ensureTerminal(portId, terminalName) {
  const normalizedName = canonicalizeLocationKey(terminalName);
  const existing = ensureTerminal.cache.get(portId) ?? [];

  const match = matchByAlias(terminalName, existing);
  const terminal =
    match ??
    (await prisma.terminal.create({
      data: {
        portId,
        name: terminalName,
        normalizedName,
      },
      include: { aliases: true },
    }));

  await prisma.terminalAlias.upsert({
    where: {
      terminalId_normalizedName: {
        terminalId: terminal.id,
        normalizedName,
      },
    },
    update: {},
    create: {
      terminalId: terminal.id,
      name: terminalName,
      normalizedName,
    },
  });

  if (!existing.some((item) => item.id === terminal.id)) {
    existing.push({ ...terminal, aliases: [...(terminal.aliases ?? []), { normalizedName }] });
    ensureTerminal.cache.set(portId, existing);
  }

  return terminal;
}
ensureTerminal.cache = new Map();

async function ensureBerth(portId, terminalId, berthName) {
  const normalizedName = canonicalizeLocationKey(berthName);
  const cacheKey = `${portId}:${terminalId}`;
  const existing = ensureBerth.cache.get(cacheKey) ?? [];

  const match = matchByAlias(berthName, existing);
  const berth =
    match ??
    (await prisma.berth.create({
      data: {
        portId,
        terminalId,
        name: berthName,
        normalizedName,
      },
      include: { aliases: true },
    }));

  await prisma.berthAlias.upsert({
    where: {
      berthId_normalizedName: {
        berthId: berth.id,
        normalizedName,
      },
    },
    update: {},
    create: {
      berthId: berth.id,
      name: berthName,
      normalizedName,
    },
  });

  if (!existing.some((item) => item.id === berth.id)) {
    existing.push({ ...berth, aliases: [...(berth.aliases ?? []), { normalizedName }] });
    ensureBerth.cache.set(cacheKey, existing);
  }

  return berth;
}
ensureBerth.cache = new Map();

async function main() {
  console.log("starting Vancouver backfill");
  const port = await prisma.port.findFirst({
    where: { name: { contains: "Vancouver", mode: "insensitive" } },
    include: {
      facts: {
        orderBy: { createdAt: "asc" },
      },
    },
  });
  console.log("loaded Vancouver port");

  if (!port) {
    throw new Error("Vancouver not found");
  }

  const existingTerminals = await prisma.terminal.findMany({
    where: { portId: port.id },
    include: { aliases: true },
  });
  console.log(`loaded ${existingTerminals.length} existing terminals`);
  ensureTerminal.cache.set(port.id, existingTerminals);

  const existingBerths = await prisma.berth.findMany({
    where: { portId: port.id },
    include: { aliases: true },
  });
  console.log(`loaded ${existingBerths.length} existing berths`);
  for (const berth of existingBerths) {
    const cacheKey = `${port.id}:${berth.terminalId ?? "null"}`;
    const current = ensureBerth.cache.get(cacheKey) ?? [];
    current.push(berth);
    ensureBerth.cache.set(cacheKey, current);
  }

  let updatedFacts = 0;
  let processed = 0;

  for (const fact of port.facts) {
    processed++;
    if (processed % 10 === 0) {
      console.log(`processed ${processed}/${port.facts.length}`);
    }

    if (!fact.notes || fact.terminalId || fact.berthId) continue;

    const parsed = parseLocationHint(fact.notes);
    if (!parsed?.terminalName) continue;

    const terminal = await ensureTerminal(port.id, parsed.terminalName);
    const berthNames = parsed.berthNames ?? [];
    const createdBerths = [];
    for (const berthName of berthNames) {
      createdBerths.push(await ensureBerth(port.id, terminal.id, berthName));
    }

    const berth = createdBerths.length === 1 ? createdBerths[0] : null;

    const scope = berth ? PortFactScope.BERTH : PortFactScope.TERMINAL;

    await prisma.portFact.update({
      where: { id: fact.id },
      data: {
        scope,
        terminalId: terminal.id,
        berthId: berth?.id ?? null,
      },
    });
    updatedFacts++;

  }

  const summary = await prisma.port.findUnique({
    where: { id: port.id },
    include: {
      terminals: {
        include: { berths: true, aliases: true },
        orderBy: { name: "asc" },
      },
    },
  });

  console.log(
    JSON.stringify(
        {
          updatedFacts,
          terminals:
            summary?.terminals.map((terminal) => ({
            name: terminal.name,
            aliases: terminal.aliases.map((alias) => alias.name),
            berths: terminal.berths.map((berth) => berth.name),
          })) ?? [],
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
