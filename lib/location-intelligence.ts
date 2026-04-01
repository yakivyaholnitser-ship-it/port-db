import OpenAI from "openai";
import { PortFactScope, Prisma } from "@prisma/client";
import { normalizeLocationName } from "@/lib/location-matching";
import {
  adjudicateLocationHierarchyWithAI,
  mapToExistingHierarchyWithAI,
  persistLocationMatchLogs,
  resolveBerth,
  resolveTerminal,
  type MatchLogDraft,
} from "@/lib/location-resolver";

type DbClient = Prisma.TransactionClient | Prisma.DefaultPrismaClient;

export type ExtractedLocationFact = {
  scope?: string | null;
  terminal?: string | null;
  berth?: string | null;
  category: string;
  value: string;
  unit?: string | null;
  notes?: string | null;
  rawSnippet?: string | null;
};

export type ResolvedLocationFactRow = {
  scope: PortFactScope;
  category: string;
  value: string;
  unit: string | null;
  notes: string | null;
  rawSnippet: string | null;
  portId: number;
  terminalId: number | null;
  berthId: number | null;
};

function parseScope(scope: string | null | undefined): PortFactScope {
  switch ((scope ?? "").toLowerCase()) {
    case "berth":
      return PortFactScope.BERTH;
    case "terminal":
      return PortFactScope.TERMINAL;
    default:
      return PortFactScope.PORT;
  }
}

const TERMINAL_CONTEXT_PREFERRED_CATEGORIES = new Set([
  "draft",
  "density",
  "air_draft",
  "loa",
  "beam",
  "dwt",
  "ukc",
  "freeboard",
  "trim",
  "displacement",
  "load_rate",
  "discharge_rate",
  "gangs",
  "shifts",
  "equipment",
  "cargo",
  "survey",
]);

function shouldKeepPortScope(rawFact: ExtractedLocationFact) {
  const haystack = [rawFact.value, rawFact.notes, rawFact.rawSnippet]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /\bpilot station\b|\bps\s*>\s*anchor\b|\banchorage\b|\banchor\b|\bbridge\b|\briver transit\b|\btransit\b|\bbunkering\b|\bcleaning\b|\bsulphur\b|\bsulfur\b|\bfog\b|\brainfall\b|\bdaylight transit\b|\bseason\b/.test(
    haystack
  );
}

function shouldInheritTopLevelTerminal(args: {
  fact: ExtractedLocationFact;
  scope: PortFactScope;
  hasFactTerminal: boolean;
  hasFactBerth: boolean;
  hasTopLevelTerminal: boolean;
}) {
  if (args.scope !== PortFactScope.PORT) return false;
  if (args.hasFactTerminal || args.hasFactBerth) return false;
  if (!args.hasTopLevelTerminal) return false;

  const category = args.fact.category.trim().toLowerCase();
  if (!TERMINAL_CONTEXT_PREFERRED_CATEGORIES.has(category)) return false;
  if (shouldKeepPortScope(args.fact)) return false;

  return true;
}

export async function resolveLocationIntelligence(args: {
  db: DbClient;
  client: OpenAI;
  port: { id: number; name: string };
  topLevelTerminalName: string | null;
  topLevelBerthName: string | null;
  facts: ExtractedLocationFact[];
  lat?: number | null;
  lon?: number | null;
}) {
  const hierarchyAdjudicationCache = new Map<
    string,
    Awaited<ReturnType<typeof adjudicateLocationHierarchyWithAI>>
  >();
  const existingHierarchyMappingCache = new Map<
    string,
    Awaited<ReturnType<typeof mapToExistingHierarchyWithAI>>
  >();
  const terminalResolutionCache = new Map<
    string,
    Awaited<ReturnType<typeof resolveTerminal>>
  >();
  const berthResolutionCache = new Map<
    string,
    Awaited<ReturnType<typeof resolveBerth>>
  >();
  const locationLogs: MatchLogDraft[] = [];

  async function resolveTerminalCached(rawTerminalName: string | null) {
    const normalizedTerminalName = rawTerminalName?.trim()
      ? normalizeLocationName(rawTerminalName)
      : null;
    const cacheKey = normalizedTerminalName ?? "__null__";

    if (terminalResolutionCache.has(cacheKey)) {
      return terminalResolutionCache.get(cacheKey)!;
    }

    const resolution = await resolveTerminal({
      db: args.db,
      client: args.client,
      portId: args.port.id,
      portName: args.port.name,
      rawTerminalName: normalizedTerminalName,
      lat: args.lat ?? null,
      lon: args.lon ?? null,
    });

    terminalResolutionCache.set(cacheKey, resolution);
    if (resolution.log) locationLogs.push(resolution.log);
    return resolution;
  }

  async function adjudicateHierarchy(rawTerminalName: string | null, rawBerthName: string | null) {
    const normalizedTerminalName = rawTerminalName?.trim()
      ? normalizeLocationName(rawTerminalName)
      : null;
    const normalizedBerthName = rawBerthName?.trim()
      ? normalizeLocationName(rawBerthName)
      : null;
    const cacheKey = `${normalizedTerminalName ?? "__null__"}::${normalizedBerthName ?? "__null__"}`;

    if (hierarchyAdjudicationCache.has(cacheKey)) {
      return hierarchyAdjudicationCache.get(cacheKey)!;
    }

    const adjudicated = await adjudicateLocationHierarchyWithAI({
      client: args.client,
      portName: args.port.name,
      rawTerminalName: normalizedTerminalName,
      rawBerthName: normalizedBerthName,
    });

    hierarchyAdjudicationCache.set(cacheKey, adjudicated);
    return adjudicated;
  }

  async function mapToExistingHierarchy(rawTerminalName: string | null, rawBerthName: string | null) {
    const normalizedTerminalName = rawTerminalName?.trim()
      ? normalizeLocationName(rawTerminalName)
      : null;
    const normalizedBerthName = rawBerthName?.trim()
      ? normalizeLocationName(rawBerthName)
      : null;
    const cacheKey = `${normalizedTerminalName ?? "__null__"}::${normalizedBerthName ?? "__null__"}`;

    if (existingHierarchyMappingCache.has(cacheKey)) {
      return existingHierarchyMappingCache.get(cacheKey)!;
    }

    const mapped = await mapToExistingHierarchyWithAI({
      db: args.db,
      client: args.client,
      portId: args.port.id,
      portName: args.port.name,
      rawTerminalName: normalizedTerminalName,
      rawBerthName: normalizedBerthName,
    });

    existingHierarchyMappingCache.set(cacheKey, mapped);
    return mapped;
  }

  async function resolveBerthCached(input: {
    terminalId: number | null;
    terminalName: string | null;
    rawBerthName: string | null;
  }) {
    const normalizedBerthName = input.rawBerthName?.trim()
      ? normalizeLocationName(input.rawBerthName)
      : null;
    const cacheKey = `${input.terminalId ?? "port"}::${input.terminalName ?? ""}::${normalizedBerthName ?? "__null__"}`;

    if (berthResolutionCache.has(cacheKey)) {
      return berthResolutionCache.get(cacheKey)!;
    }

    const resolution = await resolveBerth({
      db: args.db,
      client: args.client,
      portId: args.port.id,
      portName: args.port.name,
      terminalId: input.terminalId,
      terminalName: input.terminalName,
      rawBerthName: normalizedBerthName,
      lat: args.lat ?? null,
      lon: args.lon ?? null,
    });

    berthResolutionCache.set(cacheKey, resolution);
    if (resolution.log) locationLogs.push(resolution.log);
    return resolution;
  }

  const defaultHierarchy = await adjudicateHierarchy(
    args.topLevelTerminalName,
    args.topLevelBerthName
  );
  const defaultMappedHierarchy = await mapToExistingHierarchy(
    defaultHierarchy.terminalName,
    defaultHierarchy.berthName
  );
  const defaultTerminalResolution = await resolveTerminalCached(defaultMappedHierarchy.terminalName);
  const defaultTerminal = defaultTerminalResolution.terminal;
  const defaultBerthResolution = await resolveBerthCached({
    terminalId: defaultTerminal?.id ?? null,
    terminalName: defaultTerminal?.name ?? defaultMappedHierarchy.terminalName ?? null,
    rawBerthName: defaultMappedHierarchy.berthName,
  });
  const defaultBerth = defaultBerthResolution.berth;

  const factRows: ResolvedLocationFactRow[] = [];

  for (const fact of args.facts) {
    const hasExplicitFactTerminal = Boolean(fact.terminal?.trim());
    const hasExplicitFactBerth = Boolean(fact.berth?.trim());
    const factHierarchy = await adjudicateHierarchy(
      hasExplicitFactTerminal ? normalizeLocationName(fact.terminal!) : args.topLevelTerminalName,
      hasExplicitFactBerth ? normalizeLocationName(fact.berth!) : args.topLevelBerthName
    );
    const factMappedHierarchy = await mapToExistingHierarchy(
      factHierarchy.terminalName,
      factHierarchy.berthName
    );
    const factTerminalResolution = await resolveTerminalCached(factMappedHierarchy.terminalName);
    const factTerminal = factTerminalResolution.terminal;
    const factBerthResolution = await resolveBerthCached({
      terminalId: factTerminal?.id ?? null,
      terminalName: factTerminal?.name ?? factMappedHierarchy.terminalName ?? null,
      rawBerthName: factMappedHierarchy.berthName,
    });
    const factBerth = factBerthResolution.berth;

    let scope = parseScope(fact.scope);
    if (
      shouldInheritTopLevelTerminal({
        fact,
        scope,
        hasFactTerminal: hasExplicitFactTerminal,
        hasFactBerth: hasExplicitFactBerth,
        hasTopLevelTerminal: Boolean(defaultTerminal?.id),
      })
    ) {
      scope = PortFactScope.TERMINAL;
    }
    if (scope === PortFactScope.BERTH && !factBerth?.id) {
      scope = factTerminal?.id ? PortFactScope.TERMINAL : PortFactScope.PORT;
    }
    if (scope === PortFactScope.TERMINAL && !factTerminal?.id) {
      scope = PortFactScope.PORT;
    }

    factRows.push({
      scope,
      category: fact.category.trim(),
      value: fact.value.trim(),
      unit: fact.unit?.trim() || null,
      notes: fact.notes?.trim() || null,
      rawSnippet: fact.rawSnippet?.trim() || null,
      portId: args.port.id,
      terminalId: scope === PortFactScope.PORT ? null : (factTerminal?.id ?? null),
      berthId: scope === PortFactScope.BERTH ? (factBerth?.id ?? null) : null,
    });
  }

  const distinctTerminalIds = Array.from(
    new Set(
      factRows.map((row) => row.terminalId).filter((id): id is number => typeof id === "number")
    )
  );
  const distinctBerthIds = Array.from(
    new Set(
      factRows.map((row) => row.berthId).filter((id): id is number => typeof id === "number")
    )
  );

  const uniqueLogs = Array.from(
    new Map(
      locationLogs.map((log) => {
        const terminalId = "terminalId" in log ? (log.terminalId ?? "") : "";
        const berthId = "berthId" in log ? (log.berthId ?? "") : "";

        return [
          [
            log.entityType,
            log.rawName,
            log.normalizedName,
            log.matchedName ?? "",
            log.method,
            terminalId,
            berthId,
          ].join("::"),
          log,
        ];
      })
    ).values()
  );

  return {
    defaultTerminal,
    defaultBerth,
    factRows,
    distinctTerminalIds,
    distinctBerthIds,
    logs: uniqueLogs,
  };
}

export async function persistResolvedFacts(args: {
  db: DbClient;
  sourceRecordId: number;
  factRows: ResolvedLocationFactRow[];
}) {
  for (const row of args.factRows) {
    await args.db.portFact.create({
      data: {
        ...row,
        sourceRecordId: args.sourceRecordId,
      },
    });
  }
}

export { persistLocationMatchLogs };
