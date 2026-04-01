import OpenAI from "openai";
import {
  Prisma,
  type MatchConfidence,
  type LocationEntityType,
  type LocationMatchMethod,
  type LocationMatchStatus,
} from "@prisma/client";
import {
  canonicalizeLocationKey,
  matchByAlias,
  normalizeLocationName,
} from "@/lib/location-matching";

const MATCH_CONFIDENCE = {
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
} as const satisfies Record<string, MatchConfidence>;

const LOCATION_ENTITY_TYPE = {
  TERMINAL: "TERMINAL",
  BERTH: "BERTH",
} as const satisfies Record<string, LocationEntityType>;

const LOCATION_MATCH_METHOD = {
  EXACT: "EXACT",
  ALIAS: "ALIAS",
  FUZZY: "FUZZY",
  AI: "AI",
  CREATED_NEW: "CREATED_NEW",
} as const satisfies Record<string, LocationMatchMethod>;

const LOCATION_MATCH_STATUS = {
  MATCHED: "MATCHED",
  CREATED_NEW: "CREATED_NEW",
  NEEDS_REVIEW: "NEEDS_REVIEW",
} as const satisfies Record<string, LocationMatchStatus>;

type DbClient = Prisma.TransactionClient | Prisma.DefaultPrismaClient;

export type MatchLogDraft = {
  entityType: LocationEntityType;
  rawName: string;
  normalizedName: string;
  matchedName: string | null;
  method: LocationMatchMethod;
  confidence: MatchConfidence;
  status: LocationMatchStatus;
  reason: string | null;
  terminalId?: number | null;
  berthId?: number | null;
};

type LocationHierarchyAdjudication = {
  terminalName: string | null;
  berthName: string | null;
  confidence: MatchConfidence;
  reason: string | null;
};

function splitCombinedJettyName(value: string | null) {
  if (!value) return null;

  const normalized = normalizeLocationName(value);
  const match = normalized.match(/^(.*?\bjetty)\s+no\.?\s*([a-z0-9#-]+)$/i);
  if (!match) return null;

  const terminalName = normalizeLocationName(match[1]);
  const jettyNumber = match[2].toUpperCase();

  return {
    terminalName,
    berthName: `Jetty No. ${jettyNumber}`,
  };
}

function confidenceFromScore(score: number): MatchConfidence {
  if (score >= 0.9) return MATCH_CONFIDENCE.HIGH;
  if (score >= 0.74) return MATCH_CONFIDENCE.MEDIUM;
  return MATCH_CONFIDENCE.LOW;
}

function tokenSet(value: string): Set<string> {
  return new Set(
    canonicalizeLocationKey(value)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean)
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function bestFuzzyCandidate<T extends { normalizedName: string; aliases?: { normalizedName: string }[] }>(
  rawName: string,
  candidates: T[]
): { candidate: T; score: number } | null {
  const rawTokens = tokenSet(rawName);
  let best: { candidate: T; score: number } | null = null;

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

  return best;
}

function findBestExistingTerminal(
  rawName: string,
  terminals: Awaited<ReturnType<typeof loadTerminalsWithAliases>>
) {
  const compactRaw = canonicalizeLocationKey(rawName).replace(/[\s-]+/g, "");
  if (compactRaw) {
    const compactMatch = terminals.find((terminal) => {
      const compactTerminal = canonicalizeLocationKey(terminal.name).replace(/[\s-]+/g, "");
      if (compactTerminal === compactRaw) return true;
      return terminal.aliases?.some(
        (alias) => alias.normalizedName.replace(/[\s-]+/g, "") === compactRaw
      );
    });

    if (compactMatch) {
      return {
        candidate: compactMatch,
        confidence: MATCH_CONFIDENCE.HIGH,
        reason: "Matched compact terminal shorthand ignoring spacing and punctuation.",
      };
    }
  }

  const aliasMatch = matchByAlias(rawName, terminals);
  if (aliasMatch) {
    return {
      candidate: aliasMatch,
      confidence: MATCH_CONFIDENCE.HIGH,
      reason: "Matched existing terminal directly from shorthand.",
    };
  }

  const rawKey = canonicalizeLocationKey(rawName);
  if (/^\d+[a-zA-Z-]*$/i.test(rawKey)) {
    const suffixMatch = terminals.find((terminal) => {
      const terminalKey = canonicalizeLocationKey(terminal.name);
      return terminalKey.endsWith(rawKey);
    });

    if (suffixMatch) {
      return {
        candidate: suffixMatch,
        confidence: MATCH_CONFIDENCE.MEDIUM,
        reason: "Matched numeric shorthand to an existing terminal suffix.",
      };
    }
  }

  const fuzzy = bestFuzzyCandidate(rawName, terminals);
  if (fuzzy && fuzzy.score >= 0.82) {
    return {
      candidate: fuzzy.candidate,
      confidence: confidenceFromScore(fuzzy.score),
      reason: `Fuzzy terminal shorthand match with score ${fuzzy.score.toFixed(2)}.`,
    };
  }

  return null;
}

function compactTerminalCodeVariants(left: string, right: string) {
  const a = normalizeLocationName(`${left}${right}`);
  const b = normalizeLocationName(`${left} ${right}`);
  return Array.from(new Set([a, b].filter(Boolean)));
}

function findBestExistingBerth<
  T extends { id: number; normalizedName: string; aliases?: { normalizedName: string }[]; name: string }
>(rawName: string, berths: T[]) {
  const aliasMatch = matchByAlias(rawName, berths);
  if (aliasMatch) {
    return {
      candidate: aliasMatch,
      confidence: MATCH_CONFIDENCE.HIGH,
      reason: "Matched existing berth directly from shorthand.",
    };
  }

  const fuzzy = bestFuzzyCandidate(rawName, berths);
  if (fuzzy && fuzzy.score >= 0.82) {
    return {
      candidate: fuzzy.candidate,
      confidence: confidenceFromScore(fuzzy.score),
      reason: `Fuzzy berth shorthand match with score ${fuzzy.score.toFixed(2)}.`,
    };
  }

  return null;
}

async function loadTerminalsWithAliases(db: DbClient, portId: number) {
  const terminals = await db.terminal.findMany({
    where: { portId },
  });

  const terminalAliasModel = (db as DbClient & {
    terminalAlias?: {
      findMany: (args: {
        where: {
          terminal: {
            portId: number;
          };
        };
      }) => Promise<{ terminalId: number; normalizedName: string }[]>;
    };
  }).terminalAlias;

  const aliases = terminalAliasModel
    ? await terminalAliasModel.findMany({
        where: {
          terminal: {
            portId,
          },
        },
      })
    : [];

  return terminals.map((terminal) => ({
    ...terminal,
    aliases: aliases.filter((alias) => alias.terminalId === terminal.id),
  }));
}

async function loadBerthsWithAliases(db: DbClient, args: { portId: number; terminalId: number | null }) {
  const berths = await db.berth.findMany({
    where: {
      portId: args.portId,
      terminalId: args.terminalId ?? null,
    },
  });

  const berthAliasModel = (db as DbClient & {
    berthAlias?: {
      findMany: (args: {
        where: {
          berth: {
            portId: number;
            terminalId: number | null;
          };
        };
      }) => Promise<{ berthId: number; normalizedName: string }[]>;
    };
  }).berthAlias;

  const aliases = berthAliasModel
    ? await berthAliasModel.findMany({
        where: {
          berth: {
            portId: args.portId,
            terminalId: args.terminalId ?? null,
          },
        },
      })
    : [];

  return berths.map((berth) => ({
    ...berth,
    aliases: aliases.filter((alias) => alias.berthId === berth.id),
  }));
}

async function upsertTerminalAlias(
  db: DbClient,
  args: { terminalId: number; name: string; normalizedName: string }
) {
  const terminalAliasModel = (db as DbClient & {
    terminalAlias?: {
      upsert: (args: {
        where: { terminalId_normalizedName: { terminalId: number; normalizedName: string } };
        update: Record<string, never>;
        create: { terminalId: number; name: string; normalizedName: string };
      }) => Promise<unknown>;
    };
  }).terminalAlias;

  if (!terminalAliasModel?.upsert) return;

  await terminalAliasModel.upsert({
    where: {
      terminalId_normalizedName: {
        terminalId: args.terminalId,
        normalizedName: args.normalizedName,
      },
    },
    update: {},
    create: args,
  });
}

async function upsertBerthAlias(
  db: DbClient,
  args: { berthId: number; name: string; normalizedName: string }
) {
  const berthAliasModel = (db as DbClient & {
    berthAlias?: {
      upsert: (args: {
        where: { berthId_normalizedName: { berthId: number; normalizedName: string } };
        update: Record<string, never>;
        create: { berthId: number; name: string; normalizedName: string };
      }) => Promise<unknown>;
    };
  }).berthAlias;

  if (!berthAliasModel?.upsert) return;

  await berthAliasModel.upsert({
    where: {
      berthId_normalizedName: {
        berthId: args.berthId,
        normalizedName: args.normalizedName,
      },
    },
    update: {},
    create: args,
  });
}

async function chooseExistingLocationWithAI(args: {
  client: OpenAI;
  kind: "terminal" | "berth";
  portName: string;
  rawName: string;
  candidates: { id: number; name: string; aliases?: { normalizedName: string }[] }[];
}) {
  if (args.candidates.length === 0) return null;

  const prompt = `You are matching maritime ${args.kind} names for the same port.

Port: ${args.portName}
New ${args.kind}: "${args.rawName}"

Existing candidates:
${args.candidates
  .map(
    (candidate) =>
      `ID:${candidate.id} | ${candidate.name} | aliases: ${
        candidate.aliases?.map((alias) => alias.normalizedName).join(", ") || "none"
      }`
  )
  .join("\n")}

Return only JSON:
{
  "matchId": number | null,
  "confidence": "high" | "medium" | "low",
  "reason": string
}`;

  const completion = await args.client.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as {
    matchId?: number | null;
    confidence?: "high" | "medium" | "low";
    reason?: string;
  };

  return parsed;
}

export async function adjudicateLocationHierarchyWithAI(args: {
  client: OpenAI;
  portName: string;
  rawTerminalName: string | null;
  rawBerthName: string | null;
}) {
  const rawTerminalName = args.rawTerminalName?.trim() || null;
  const rawBerthName = args.rawBerthName?.trim() || null;

  if (!rawTerminalName && !rawBerthName) {
    return {
      terminalName: null,
      berthName: null,
      confidence: MATCH_CONFIDENCE.HIGH,
      reason: "No terminal or berth names provided.",
    } satisfies LocationHierarchyAdjudication;
  }

  const jettySplitFromTerminal = splitCombinedJettyName(rawTerminalName);
  if (jettySplitFromTerminal) {
    return {
      terminalName: jettySplitFromTerminal.terminalName,
      berthName: jettySplitFromTerminal.berthName,
      confidence: MATCH_CONFIDENCE.HIGH,
      reason: "Split combined jetty terminal and berth name.",
    } satisfies LocationHierarchyAdjudication;
  }

  if (!rawTerminalName) {
    const jettySplitFromBerth = splitCombinedJettyName(rawBerthName);
    if (jettySplitFromBerth) {
      return {
        terminalName: jettySplitFromBerth.terminalName,
        berthName: jettySplitFromBerth.berthName,
        confidence: MATCH_CONFIDENCE.HIGH,
        reason: "Split combined jetty berth phrase into terminal and berth.",
      } satisfies LocationHierarchyAdjudication;
    }
  }

  const prompt = `You are cleaning maritime location names into a port hierarchy.

Port: ${args.portName}
Raw terminal name: ${rawTerminalName ? `"${rawTerminalName}"` : "null"}
Raw berth name: ${rawBerthName ? `"${rawBerthName}"` : "null"}

Rules:
- Return the best normalized terminalName and berthName.
- If the raw terminal name actually contains both operator/terminal and berth, split it.
- If the raw berth name contains both operator/terminal and berth, split it.
- Keep short terminal IDs like "LB212" or "G3" if they are valid location labels.
- Keep compact berth labels like "B12" or numbered berth references when they are real location names.
- Short update-style names still count as valid locations if they clearly identify a terminal or berth.
- If there is no berth, return berthName as null.
- Do not invent information not implied by the raw names.

Return only JSON:
{
  "terminalName": string | null,
  "berthName": string | null,
  "confidence": "high" | "medium" | "low",
  "reason": string
}`;

  const completion = await args.client.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as {
    terminalName?: string | null;
    berthName?: string | null;
    confidence?: "high" | "medium" | "low";
    reason?: string;
  };

  return {
    terminalName: parsed.terminalName?.trim() || null,
    berthName: parsed.berthName?.trim() || null,
    confidence:
      parsed.confidence === "high"
        ? MATCH_CONFIDENCE.HIGH
        : parsed.confidence === "low"
          ? MATCH_CONFIDENCE.LOW
          : MATCH_CONFIDENCE.MEDIUM,
    reason: parsed.reason ?? "AI adjudicated terminal and berth hierarchy.",
  } satisfies LocationHierarchyAdjudication;
}

export async function mapToExistingHierarchyWithAI(args: {
  db: DbClient;
  client: OpenAI;
  portId: number;
  portName: string;
  rawTerminalName: string | null;
  rawBerthName: string | null;
}) {
  const rawTerminalName = args.rawTerminalName?.trim() || null;
  const rawBerthName = args.rawBerthName?.trim() || null;

  if (!rawTerminalName && !rawBerthName) {
    return {
      terminalName: null,
      berthName: null,
      confidence: MATCH_CONFIDENCE.HIGH,
      reason: "No shorthand location to map.",
    } satisfies LocationHierarchyAdjudication;
  }

  const shouldAttemptMapping =
    Boolean(rawTerminalName && rawTerminalName.length <= 8) ||
    Boolean(rawBerthName && rawBerthName.length <= 8) ||
    Boolean(rawTerminalName && /^\d+[a-zA-Z-]*$/i.test(rawTerminalName)) ||
    Boolean(rawBerthName && /^\d+[a-zA-Z-]*$/i.test(rawBerthName));

  if (!shouldAttemptMapping) {
    return {
      terminalName: rawTerminalName,
      berthName: rawBerthName,
      confidence: MATCH_CONFIDENCE.HIGH,
      reason: "Location labels are already explicit enough.",
    } satisfies LocationHierarchyAdjudication;
  }

  const terminals = await loadTerminalsWithAliases(args.db, args.portId);
  const berths = await args.db.berth.findMany({
    where: { portId: args.portId },
    include: {
      terminal: true,
    },
  });

  if (!rawTerminalName && rawBerthName) {
    const directTerminalFromBerthSlot = findBestExistingTerminal(rawBerthName, terminals);
    if (directTerminalFromBerthSlot) {
      return {
        terminalName: directTerminalFromBerthSlot.candidate.name,
        berthName: null,
        confidence: directTerminalFromBerthSlot.confidence,
        reason: directTerminalFromBerthSlot.reason,
      } satisfies LocationHierarchyAdjudication;
    }
  }

  if (rawTerminalName && rawBerthName) {
    for (const variant of compactTerminalCodeVariants(rawTerminalName, rawBerthName)) {
      const combinedTerminal = findBestExistingTerminal(variant, terminals);
      if (combinedTerminal) {
        return {
          terminalName: combinedTerminal.candidate.name,
          berthName: null,
          confidence: combinedTerminal.confidence,
          reason: "Combined compact terminal fragments into an existing terminal.",
        } satisfies LocationHierarchyAdjudication;
      }
    }
  }

  if (rawTerminalName) {
    const matchedTerminal = findBestExistingTerminal(rawTerminalName, terminals);
    if (matchedTerminal && rawBerthName) {
      const berthsForTerminal = berths.filter(
        (berth) => berth.terminal?.id === matchedTerminal.candidate.id
      );
      const matchedBerth = findBestExistingBerth(rawBerthName, berthsForTerminal);

      if (matchedBerth) {
        return {
          terminalName: matchedTerminal.candidate.name,
          berthName: matchedBerth.candidate.name,
          confidence:
            matchedTerminal.confidence === MATCH_CONFIDENCE.HIGH &&
            matchedBerth.confidence === MATCH_CONFIDENCE.HIGH
              ? MATCH_CONFIDENCE.HIGH
              : MATCH_CONFIDENCE.MEDIUM,
          reason: "Matched shorthand to an existing terminal and berth in this port.",
        } satisfies LocationHierarchyAdjudication;
      }
    }
  }

  const prompt = `You are mapping shorthand maritime location names to the existing canonical hierarchy for one port.

Port: ${args.portName}
Raw terminal name: ${rawTerminalName ? `"${rawTerminalName}"` : "null"}
Raw berth name: ${rawBerthName ? `"${rawBerthName}"` : "null"}

Existing terminals:
${terminals
  .map(
    (terminal) =>
      `- ${terminal.name} | aliases: ${
        terminal.aliases.map((alias) => alias.name).join(", ") || "none"
      }`
  )
  .join("\n")}

Existing berths:
${berths
  .map(
    (berth) =>
      `- ${berth.terminal?.name ? `${berth.terminal.name} > ` : ""}${berth.name}`
  )
  .join("\n")}

Rules:
- If the shorthand clearly refers to an existing terminal, return that terminalName.
- If the shorthand clearly refers to an existing berth, return that berthName and its parent terminalName when known.
- Prefer reusing existing canonical names over creating a new location.
- Do not invent new names.

Return only JSON:
{
  "terminalName": string | null,
  "berthName": string | null,
  "confidence": "high" | "medium" | "low",
  "reason": string
}`;

  const completion = await args.client.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as {
    terminalName?: string | null;
    berthName?: string | null;
    confidence?: "high" | "medium" | "low";
    reason?: string;
  };

  let mappedTerminalName = parsed.terminalName?.trim() || rawTerminalName;
  let mappedBerthName = parsed.berthName?.trim() || rawBerthName;

  if (!mappedTerminalName && mappedBerthName) {
    const directTerminalFromBerthSlot = findBestExistingTerminal(mappedBerthName, terminals);
    if (directTerminalFromBerthSlot) {
      mappedTerminalName = directTerminalFromBerthSlot.candidate.name;
      mappedBerthName = null;
    }
  }

  if (mappedTerminalName && mappedBerthName) {
    for (const variant of compactTerminalCodeVariants(mappedTerminalName, mappedBerthName)) {
      const combinedTerminal = findBestExistingTerminal(variant, terminals);
      if (combinedTerminal) {
        mappedTerminalName = combinedTerminal.candidate.name;
        mappedBerthName = null;
        break;
      }
    }
  }

  if (mappedTerminalName && mappedBerthName) {
    const matchedTerminal = terminals.find(
      (terminal) => terminal.name.toLowerCase() === mappedTerminalName.toLowerCase()
    );

    const terminalHasStructuredBerths = berths.some(
      (berth) => berth.terminal?.name?.toLowerCase() === mappedTerminalName.toLowerCase()
    );

    const berthKey = canonicalizeLocationKey(mappedBerthName);
    const terminalKey = canonicalizeLocationKey(mappedTerminalName);

    if (
      matchedTerminal &&
      !terminalHasStructuredBerths &&
      berthKey &&
      terminalKey &&
      (terminalKey.endsWith(berthKey) || terminalKey.includes(berthKey))
    ) {
      mappedBerthName = null;
    }

    const berthActuallyLooksLikeSameTerminal =
      matchedTerminal &&
      berthKey &&
      canonicalizeLocationKey(matchedTerminal.name) === berthKey;

    if (berthActuallyLooksLikeSameTerminal) {
      mappedBerthName = null;
    }

    if (matchedTerminal && mappedBerthName) {
      const berthsForTerminal = berths.filter((berth) => berth.terminal?.id === matchedTerminal.id);
      const directBerth = findBestExistingBerth(mappedBerthName, berthsForTerminal);
      if (directBerth) {
        mappedBerthName = directBerth.candidate.name;
      }
    }
  }

  return {
    terminalName: mappedTerminalName,
    berthName: mappedBerthName,
    confidence:
      parsed.confidence === "high"
        ? MATCH_CONFIDENCE.HIGH
        : parsed.confidence === "low"
          ? MATCH_CONFIDENCE.LOW
          : MATCH_CONFIDENCE.MEDIUM,
    reason: parsed.reason ?? "AI mapped shorthand to existing hierarchy.",
  } satisfies LocationHierarchyAdjudication;
}

export async function resolveTerminal(args: {
  db: DbClient;
  client: OpenAI;
  portId: number;
  portName: string;
  rawTerminalName: string | null;
  lat?: number | null;
  lon?: number | null;
}) {
  if (!args.rawTerminalName?.trim()) {
    return { terminal: null, log: null as MatchLogDraft | null };
  }

  const terminalName = normalizeLocationName(args.rawTerminalName);
  const normalizedName = canonicalizeLocationKey(terminalName);
  if (!normalizedName) {
    return { terminal: null, log: null as MatchLogDraft | null };
  }

  const existing = await loadTerminalsWithAliases(args.db, args.portId);

  const aliasMatch = matchByAlias(terminalName, existing);
  if (aliasMatch) {
    const terminal = await args.db.terminal.update({
      where: { id: aliasMatch.id },
      data: {
        lat: aliasMatch.lat ?? args.lat ?? null,
        lon: aliasMatch.lon ?? args.lon ?? null,
      },
    });

    await upsertTerminalAlias(args.db, {
      terminalId: terminal.id,
      name: terminalName,
      normalizedName,
    });

    const method =
      aliasMatch.normalizedName === normalizedName
        ? LOCATION_MATCH_METHOD.EXACT
        : LOCATION_MATCH_METHOD.ALIAS;

    return {
      terminal,
      log: {
        entityType: LOCATION_ENTITY_TYPE.TERMINAL,
        rawName: terminalName,
        normalizedName,
        matchedName: terminal.name,
        method,
        confidence: MATCH_CONFIDENCE.HIGH,
        status: LOCATION_MATCH_STATUS.MATCHED,
        reason: method === LOCATION_MATCH_METHOD.EXACT ? "Exact normalized terminal match." : "Matched an existing terminal alias.",
        terminalId: terminal.id,
      },
    };
  }

  const fuzzy = bestFuzzyCandidate(terminalName, existing);
  if (fuzzy && fuzzy.score >= 0.82) {
    const terminal = await args.db.terminal.update({
      where: { id: fuzzy.candidate.id },
      data: {
        lat: fuzzy.candidate.lat ?? args.lat ?? null,
        lon: fuzzy.candidate.lon ?? args.lon ?? null,
      },
    });

    await upsertTerminalAlias(args.db, {
      terminalId: terminal.id,
      name: terminalName,
      normalizedName,
    });

    return {
      terminal,
      log: {
        entityType: LOCATION_ENTITY_TYPE.TERMINAL,
        rawName: terminalName,
        normalizedName,
        matchedName: terminal.name,
        method: LOCATION_MATCH_METHOD.FUZZY,
        confidence: confidenceFromScore(fuzzy.score),
        status:
          confidenceFromScore(fuzzy.score) === MATCH_CONFIDENCE.MEDIUM
            ? LOCATION_MATCH_STATUS.NEEDS_REVIEW
            : LOCATION_MATCH_STATUS.MATCHED,
        reason: `Fuzzy terminal match with score ${fuzzy.score.toFixed(2)}.`,
        terminalId: terminal.id,
      },
    };
  }

  const ai = await chooseExistingLocationWithAI({
    client: args.client,
    kind: "terminal",
    portName: args.portName,
    rawName: terminalName,
    candidates: existing.map((terminal) => ({
      id: terminal.id,
      name: terminal.name,
      aliases: terminal.aliases,
    })),
  });

  if (
    ai?.matchId &&
    (ai.confidence === "high" || ai.confidence === "medium")
  ) {
    const matched = existing.find((terminal) => terminal.id === ai.matchId);
    if (matched) {
      const terminal = await args.db.terminal.update({
        where: { id: matched.id },
        data: {
          lat: matched.lat ?? args.lat ?? null,
          lon: matched.lon ?? args.lon ?? null,
        },
      });

      await upsertTerminalAlias(args.db, {
        terminalId: terminal.id,
        name: terminalName,
        normalizedName,
      });

      return {
        terminal,
        log: {
          entityType: LOCATION_ENTITY_TYPE.TERMINAL,
          rawName: terminalName,
          normalizedName,
          matchedName: terminal.name,
          method: LOCATION_MATCH_METHOD.AI,
          confidence:
            ai.confidence === "high" ? MATCH_CONFIDENCE.HIGH : MATCH_CONFIDENCE.MEDIUM,
          status:
            ai.confidence === "medium"
              ? LOCATION_MATCH_STATUS.NEEDS_REVIEW
              : LOCATION_MATCH_STATUS.MATCHED,
          reason: ai.reason ?? "AI matched this terminal to an existing entity.",
          terminalId: terminal.id,
        },
      };
    }
  }

  const terminal = await args.db.terminal.create({
    data: {
      portId: args.portId,
      name: terminalName,
      normalizedName,
      lat: args.lat ?? null,
      lon: args.lon ?? null,
    },
  });

  await upsertTerminalAlias(args.db, {
    terminalId: terminal.id,
    name: terminalName,
    normalizedName,
  });

  return {
    terminal,
    log: {
      entityType: LOCATION_ENTITY_TYPE.TERMINAL,
      rawName: terminalName,
      normalizedName,
      matchedName: terminal.name,
      method: LOCATION_MATCH_METHOD.CREATED_NEW,
      confidence: MATCH_CONFIDENCE.MEDIUM,
      status: LOCATION_MATCH_STATUS.CREATED_NEW,
      reason: "Created a new terminal because no reliable match was found.",
      terminalId: terminal.id,
    },
  };
}

export async function resolveBerth(args: {
  db: DbClient;
  client: OpenAI;
  portId: number;
  portName: string;
  terminalId: number | null;
  terminalName: string | null;
  rawBerthName: string | null;
  lat?: number | null;
  lon?: number | null;
}) {
  if (!args.rawBerthName?.trim()) {
    return { berth: null, log: null as MatchLogDraft | null };
  }

  const berthName = normalizeLocationName(args.rawBerthName);
  const normalizedName = canonicalizeLocationKey(berthName);
  if (!normalizedName) {
    return { berth: null, log: null as MatchLogDraft | null };
  }

  const existing = await loadBerthsWithAliases(args.db, {
    portId: args.portId,
    terminalId: args.terminalId ?? null,
  });

  const aliasMatch = matchByAlias(berthName, existing);
  if (aliasMatch) {
    const berth = await args.db.berth.update({
      where: { id: aliasMatch.id },
      data: {
        lat: aliasMatch.lat ?? args.lat ?? null,
        lon: aliasMatch.lon ?? args.lon ?? null,
        terminalId: args.terminalId ?? aliasMatch.terminalId ?? null,
      },
    });

    await upsertBerthAlias(args.db, {
      berthId: berth.id,
      name: berthName,
      normalizedName,
    });

    const method =
      aliasMatch.normalizedName === normalizedName
        ? LOCATION_MATCH_METHOD.EXACT
        : LOCATION_MATCH_METHOD.ALIAS;

    return {
      berth,
      log: {
        entityType: LOCATION_ENTITY_TYPE.BERTH,
        rawName: berthName,
        normalizedName,
        matchedName: berth.name,
        method,
        confidence: MATCH_CONFIDENCE.HIGH,
        status: LOCATION_MATCH_STATUS.MATCHED,
        reason: method === LOCATION_MATCH_METHOD.EXACT ? "Exact normalized berth match." : "Matched an existing berth alias.",
        berthId: berth.id,
      },
    };
  }

  const fuzzy = bestFuzzyCandidate(berthName, existing);
  if (fuzzy && fuzzy.score >= 0.82) {
    const berth = await args.db.berth.update({
      where: { id: fuzzy.candidate.id },
      data: {
        lat: fuzzy.candidate.lat ?? args.lat ?? null,
        lon: fuzzy.candidate.lon ?? args.lon ?? null,
        terminalId: args.terminalId ?? fuzzy.candidate.terminalId ?? null,
      },
    });

    await upsertBerthAlias(args.db, {
      berthId: berth.id,
      name: berthName,
      normalizedName,
    });

    return {
      berth,
      log: {
        entityType: LOCATION_ENTITY_TYPE.BERTH,
        rawName: berthName,
        normalizedName,
        matchedName: berth.name,
        method: LOCATION_MATCH_METHOD.FUZZY,
        confidence: confidenceFromScore(fuzzy.score),
        status:
          confidenceFromScore(fuzzy.score) === MATCH_CONFIDENCE.MEDIUM
            ? LOCATION_MATCH_STATUS.NEEDS_REVIEW
            : LOCATION_MATCH_STATUS.MATCHED,
        reason: `Fuzzy berth match with score ${fuzzy.score.toFixed(2)}.`,
        berthId: berth.id,
      },
    };
  }

  const ai = await chooseExistingLocationWithAI({
    client: args.client,
    kind: "berth",
    portName: args.terminalName ? `${args.portName} > ${args.terminalName}` : args.portName,
    rawName: berthName,
    candidates: existing.map((berth) => ({
      id: berth.id,
      name: berth.name,
      aliases: berth.aliases,
    })),
  });

  if (
    ai?.matchId &&
    (ai.confidence === "high" || ai.confidence === "medium")
  ) {
    const matched = existing.find((berth) => berth.id === ai.matchId);
    if (matched) {
      const berth = await args.db.berth.update({
        where: { id: matched.id },
        data: {
          lat: matched.lat ?? args.lat ?? null,
          lon: matched.lon ?? args.lon ?? null,
          terminalId: args.terminalId ?? matched.terminalId ?? null,
        },
      });

      await upsertBerthAlias(args.db, {
        berthId: berth.id,
        name: berthName,
        normalizedName,
      });

      return {
        berth,
        log: {
          entityType: LOCATION_ENTITY_TYPE.BERTH,
          rawName: berthName,
          normalizedName,
          matchedName: berth.name,
          method: LOCATION_MATCH_METHOD.AI,
          confidence:
            ai.confidence === "high" ? MATCH_CONFIDENCE.HIGH : MATCH_CONFIDENCE.MEDIUM,
          status:
            ai.confidence === "medium"
              ? LOCATION_MATCH_STATUS.NEEDS_REVIEW
              : LOCATION_MATCH_STATUS.MATCHED,
          reason: ai.reason ?? "AI matched this berth to an existing entity.",
          berthId: berth.id,
        },
      };
    }
  }

  const berth = await args.db.berth.create({
    data: {
      portId: args.portId,
      terminalId: args.terminalId ?? null,
      name: berthName,
      normalizedName,
      lat: args.lat ?? null,
      lon: args.lon ?? null,
    },
  });

  await upsertBerthAlias(args.db, {
    berthId: berth.id,
    name: berthName,
    normalizedName,
  });

  return {
    berth,
    log: {
      entityType: LOCATION_ENTITY_TYPE.BERTH,
      rawName: berthName,
      normalizedName,
      matchedName: berth.name,
      method: LOCATION_MATCH_METHOD.CREATED_NEW,
      confidence: MATCH_CONFIDENCE.MEDIUM,
      status: LOCATION_MATCH_STATUS.CREATED_NEW,
      reason: "Created a new berth because no reliable match was found.",
      berthId: berth.id,
    },
  };
}

export async function persistLocationMatchLogs(args: {
  db: DbClient;
  portId: number;
  sourceRecordId: number | null;
  logs: MatchLogDraft[];
}) {
  const logs = args.logs.filter(Boolean);
  if (logs.length === 0) return;

  for (const log of logs) {
    await args.db.locationMatchLog.create({
      data: {
        ...log,
        portId: args.portId,
        sourceRecordId: args.sourceRecordId,
        terminalId: log.terminalId ?? null,
        berthId: log.berthId ?? null,
      },
    });
  }
}
