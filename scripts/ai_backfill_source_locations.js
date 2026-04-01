/* eslint-disable @typescript-eslint/no-require-imports */
const OpenAI = require("openai");
const {
  PrismaClient,
  PortFactScope,
  LocationEntityType,
  LocationMatchMethod,
  MatchConfidence,
  LocationMatchStatus,
} = require("@prisma/client");

const prisma = new PrismaClient();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60000, maxRetries: 1 });

const systemPrompt = `You extract structured maritime intelligence from free-form port messages.

Return only one JSON object with this shape:
{
  "port": string,
  "country": string | null,
  "terminal": string | null,
  "berth": string | null,
  "facts": [
    {
      "scope": "port" | "terminal" | "berth",
      "terminal": string | null,
      "berth": string | null,
      "category": string,
      "value": string,
      "unit": string | null,
      "notes": string | null,
      "rawSnippet": string | null
    }
  ]
}

Rules:
- Keep "port" as city/port name only, no "Port of" prefix.
- If terminal or berth is not stated, return null.
- If different facts refer to different terminals or berths in the same message, set terminal/berth on each fact individually.
- Use the top-level terminal/berth only when the whole message clearly refers to one single location.
- If a fact clearly applies to a berth, set scope to "berth".
- If a fact clearly applies to a terminal but not a berth, set scope to "terminal".
- If a fact applies to the whole port, set scope to "port".
- Valid categories include: draft, density, discharge_rate, load_rate, tide, equipment, gangs, shifts, cargo, restriction, customs, bunker, cleaning, survey, ukc, trim, loa, beam, dwt, air_draft, production, sulphur, transit, distance_ps_to_anchorage, distance_ps_to_berth, other.
- Capture operationally important details even if they do not fit a standard bucket; use category "other" when needed.
- Never drop a meaningful operational constraint or note.`;

function normalizeLocationName(value) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizePortName(value) {
  return value
    .replace(/\s*\([^)]*\)\s*$/i, "")
    .replace(/\b(Port of|Port)\s+/i, "")
    .replace(/\s+Port$/i, "")
    .replace(/\s+/g, " ")
    .trim();
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

function parseScope(scope) {
  switch ((scope || "").toLowerCase()) {
    case "berth":
      return PortFactScope.BERTH;
    case "terminal":
      return PortFactScope.TERMINAL;
    default:
      return PortFactScope.PORT;
  }
}

function normalizeText(value) {
  return (value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenSet(value) {
  return new Set(
    normalizeText(value)
      .replace(/[^\w\s.-]/g, " ")
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

function scoreFactMatch(existing, extracted) {
  let score = 0;

  if (existing.category === extracted.category) score += 5;
  if (normalizeText(existing.value) === normalizeText(extracted.value)) score += 5;
  if (normalizeText(existing.unit) === normalizeText(extracted.unit)) score += 2;
  if (normalizeText(existing.rawSnippet) && normalizeText(existing.rawSnippet) === normalizeText(extracted.rawSnippet)) score += 8;
  if (normalizeText(existing.notes) && normalizeText(existing.notes) === normalizeText(extracted.notes)) score += 5;

  const snippetScore = jaccardSimilarity(tokenSet(existing.rawSnippet), tokenSet(extracted.rawSnippet));
  const notesScore = jaccardSimilarity(tokenSet(existing.notes), tokenSet(extracted.notes));
  const valueScore = jaccardSimilarity(tokenSet(existing.value), tokenSet(extracted.value));

  score += snippetScore * 6;
  score += notesScore * 3;
  score += valueScore * 2;

  return score;
}

function greedyMatchFacts(existingFacts, extractedFacts) {
  const available = new Set(extractedFacts.map((_, index) => index));
  const matches = [];

  for (const fact of existingFacts) {
    let best = null;

    for (const index of available) {
      const extracted = extractedFacts[index];
      const score = scoreFactMatch(fact, extracted);
      if (!best || score > best.score) {
        best = { index, score };
      }
    }

    if (best && best.score >= 7) {
      matches.push({
        fact,
        extracted: extractedFacts[best.index],
        score: best.score,
      });
      available.delete(best.index);
    }
  }

  return matches;
}

async function resolveTerminal(portId, rawTerminalName) {
  if (!rawTerminalName || !rawTerminalName.trim()) return { terminal: null, log: null };

  const terminalName = normalizeLocationName(rawTerminalName);
  const normalizedName = canonicalizeLocationKey(terminalName);
  if (!normalizedName) return { terminal: null, log: null };

  const terminals = await prisma.terminal.findMany({
    where: { portId },
    include: { aliases: true },
  });

  let existing =
    terminals.find((terminal) => terminal.normalizedName === normalizedName) ||
    terminals.find((terminal) =>
      terminal.aliases.some((alias) => alias.normalizedName === normalizedName)
    );

  if (!existing) {
    existing = await prisma.terminal.create({
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
      terminal: existing,
      log: {
        entityType: LocationEntityType.TERMINAL,
        rawName: terminalName,
        normalizedName,
        matchedName: existing.name,
        method: LocationMatchMethod.BACKFILL,
        confidence: MatchConfidence.MEDIUM,
        status: LocationMatchStatus.CREATED_NEW,
        reason: "AI backfill created a terminal from historical source text.",
        terminalId: existing.id,
        berthId: null,
      },
    };
  }

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
      reason: "AI backfill matched a historical fact to an existing terminal.",
      terminalId: existing.id,
      berthId: null,
    },
  };
}

async function resolveBerth(portId, terminalId, rawBerthName) {
  if (!rawBerthName || !rawBerthName.trim()) return { berth: null, log: null };

  const berthName = normalizeLocationName(rawBerthName);
  const normalizedName = canonicalizeLocationKey(berthName);
  if (!normalizedName) return { berth: null, log: null };

  const berths = await prisma.berth.findMany({
    where: { portId, terminalId },
    include: { aliases: true },
  });

  let existing =
    berths.find((berth) => berth.normalizedName === normalizedName) ||
    berths.find((berth) =>
      berth.aliases.some((alias) => alias.normalizedName === normalizedName)
    );

  if (!existing) {
    existing = await prisma.berth.create({
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
      berth: existing,
      log: {
        entityType: LocationEntityType.BERTH,
        rawName: berthName,
        normalizedName,
        matchedName: existing.name,
        method: LocationMatchMethod.BACKFILL,
        confidence: MatchConfidence.MEDIUM,
        status: LocationMatchStatus.CREATED_NEW,
        reason: "AI backfill created a berth from historical source text.",
        terminalId,
        berthId: existing.id,
      },
    };
  }

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
      reason: "AI backfill matched a historical fact to an existing berth.",
      terminalId,
      berthId: existing.id,
    },
  };
}

function uniqueLogs(logs) {
  return Array.from(
    new Map(
      logs
        .filter(Boolean)
        .map((log) => [
          [
            log.entityType,
            log.rawName,
            log.normalizedName,
            log.matchedName || "",
            log.method,
            log.terminalId || "",
            log.berthId || "",
          ].join("::"),
          log,
        ])
    ).values()
  );
}

function getArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

async function backfillSourceRecord(sourceRecord) {
  console.log(`processing sourceRecord ${sourceRecord.id} (${sourceRecord.port.name})`);

  const completion = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: sourceRecord.rawText },
    ],
    response_format: { type: "json_object" },
  });

  const extracted = JSON.parse(completion.choices[0]?.message?.content || "{}");
  const facts = Array.isArray(extracted.facts)
    ? extracted.facts.filter((fact) => fact?.category && fact?.value)
    : [];

  const matches = greedyMatchFacts(sourceRecord.facts, facts);
  const logs = [];
  let updatedFacts = 0;
  const assignedTerminalIds = [];
  const assignedBerthIds = [];

  for (const match of matches) {
    const topLevelTerminal = extracted.terminal ? normalizeLocationName(extracted.terminal) : null;
    const topLevelBerth = extracted.berth ? normalizeLocationName(extracted.berth) : null;
    const rawTerminalName = match.extracted.terminal?.trim()
      ? normalizeLocationName(match.extracted.terminal)
      : topLevelTerminal;
    const terminalResolution = await resolveTerminal(sourceRecord.portId, rawTerminalName);

    const rawBerthName = match.extracted.berth?.trim()
      ? normalizeLocationName(match.extracted.berth)
      : topLevelBerth;
    const berthResolution = await resolveBerth(
      sourceRecord.portId,
      terminalResolution.terminal?.id || null,
      rawBerthName
    );

    let scope = parseScope(match.extracted.scope);
    if (scope === PortFactScope.BERTH && !berthResolution.berth?.id) {
      scope = terminalResolution.terminal?.id ? PortFactScope.TERMINAL : PortFactScope.PORT;
    }
    if (scope === PortFactScope.TERMINAL && !terminalResolution.terminal?.id) {
      scope = PortFactScope.PORT;
    }

    await prisma.portFact.update({
      where: { id: match.fact.id },
      data: {
        scope,
        terminalId: scope === PortFactScope.PORT ? null : (terminalResolution.terminal?.id || null),
        berthId: scope === PortFactScope.BERTH ? (berthResolution.berth?.id || null) : null,
      },
    });

    if (terminalResolution.terminal?.id) {
      assignedTerminalIds.push(terminalResolution.terminal.id);
    }
    if (berthResolution.berth?.id) {
      assignedBerthIds.push(berthResolution.berth.id);
    }

    logs.push(terminalResolution.log, berthResolution.log);
    updatedFacts++;
  }

  const distinctTerminalIds = Array.from(
    new Set(assignedTerminalIds.filter((id) => typeof id === "number"))
  );
  const distinctBerthIds = Array.from(
    new Set(assignedBerthIds.filter((id) => typeof id === "number"))
  );

  await prisma.locationMatchLog.createMany({
    data: uniqueLogs(logs).map((log) => ({
      ...log,
      portId: sourceRecord.portId,
      sourceRecordId: sourceRecord.id,
    })),
  });

  await prisma.sourceRecord.update({
    where: { id: sourceRecord.id },
    data: {
      terminalId: distinctTerminalIds.length === 1 ? distinctTerminalIds[0] : null,
      berthId: distinctBerthIds.length === 1 ? distinctBerthIds[0] : null,
    },
  });

  return {
    sourceRecordId: sourceRecord.id,
    extractedFacts: facts.length,
    matchedFacts: matches.length,
    updatedFacts,
  };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const portNameArg = getArg("port");
  const sourceRecordIdArg = getArg("source-record-id");

  const where = sourceRecordIdArg
    ? { id: Number(sourceRecordIdArg) }
    : portNameArg
      ? { port: { name: { equals: normalizePortName(portNameArg), mode: "insensitive" } } }
      : null;

  if (!where) {
    throw new Error("Pass --port=\"Port Name\" or --source-record-id=123");
  }

  const sourceRecords = await prisma.sourceRecord.findMany({
    where,
    include: {
      facts: {
        orderBy: { id: "asc" },
      },
      port: true,
    },
    orderBy: { id: "asc" },
  });

  const candidates = sourceRecords.filter(
    (record) =>
      record.facts.length > 0 &&
      record.facts.some((fact) => !fact.terminalId && !fact.berthId)
  );

  const results = [];

  for (const sourceRecord of candidates) {
    const result = await backfillSourceRecord(sourceRecord);
    results.push({
      port: sourceRecord.port.name,
      ...result,
    });
  }

  console.log(JSON.stringify({ processed: candidates.length, results }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
