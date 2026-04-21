import { NextRequest, NextResponse } from "next/server";
import { PortFactScope } from "@prisma/client";
import OpenAI from "openai";
import { prisma } from "@/lib/prisma";
import { getDatabaseUnavailableMessage, getSchemaMismatchMessage } from "@/lib/db-errors";
import { buildOperationalView } from "@/lib/operational-view";
import { conditionTagsFromParsed, parseOperationalConditions } from "@/lib/condition-parsing";
import { inferCapabilities } from "@/lib/capability-inference";
import {
  BunkerMode,
  bunkerModeLabel,
  isBunkerLocationFact,
  parseBunkerModes,
} from "@/lib/bunker-semantics";

type FactForFilters = {
  category: string;
  value: string;
  unit: string | null;
  notes: string | null;
  rawSnippet?: string | null;
  scope: PortFactScope;
  terminal: { name: string } | null;
  berth: { name: string } | null;
  sourceRecord: { sourceDate: Date | null } | null;
  createdAt: Date;
};

type PortForFilters = {
  name: string;
  country: string | null;
  facts: FactForFilters[];
};

type NumericParameter =
  | "draft"
  | "loa"
  | "beam"
  | "air_draft"
  | "dwt"
  | "density"
  | "load_rate"
  | "discharge_rate"
  | "gangs"
  | "shifts"
  | "ukc"
  | "freeboard"
  | "trim"
  | "tide";

type NumericFilter = {
  kind: "numeric";
  parameter: NumericParameter;
  comparator: "gt" | "gte" | "lt" | "lte";
  threshold: number;
  displayThreshold: string;
};

type NumericRangeFilter = {
  kind: "numeric_range";
  parameter: NumericParameter;
  minThreshold: number;
  maxThreshold: number;
  displayRange: string;
};

type CapabilityFilter = {
  kind: "capability";
  capability: string;
  displayLabel: string;
};

type ConditionFilter = {
  kind: "condition";
  token: string;
  displayLabel: string;
};

type CountryFilter = {
  kind: "country";
  country: string;
  displayLabel: string;
};

type DeterministicFilter =
  | NumericFilter
  | NumericRangeFilter
  | CapabilityFilter
  | ConditionFilter
  | CountryFilter;

type DeterministicQuery = {
  filters: DeterministicFilter[];
  mode: "and" | "or";
  scope: "port" | "terminal" | "berth";
  portContextName?: string;
  terminalContextName?: string;
  negateCapabilities: string[];
  negateConditions: string[];
};

type SemanticPlannerFilter =
  | {
      type: "numeric";
      category: NumericParameter;
      operator: "gt" | "gte" | "lt" | "lte" | "between";
      value?: number;
      min?: number;
      max?: number;
      unit?: string;
    }
  | {
      type: "capability";
      capability: string;
      mode: "include" | "exclude";
    }
  | {
      type: "condition";
      condition: string;
      mode: "include" | "exclude";
    }
  | {
      type: "country";
      country: string;
    };

type SemanticPlannerResult = {
  intent: "filter" | "other";
  scope: "port" | "terminal" | "berth";
  combineMode: "and" | "or";
  locationContext?: {
    port?: string;
    terminal?: string;
  };
  filters: SemanticPlannerFilter[];
};

type MatchedLocation = {
  portName: string;
  portCountry?: string;
  terminalName?: string;
  berthName?: string;
};

type BunkerIntent =
  | "anchorage_only"
  | "alongside_allowed"
  | "alongside_only"
  | "barge_only"
  | "not_available"
  | "mixed";

type ParsedBunkerQuestion = {
  intent: BunkerIntent;
  scope: "port" | "terminal" | "berth";
  portContextName?: string;
  terminalContextName?: string;
};

type ParsedRestrictionQuestion = {
  scope: "port" | "terminal" | "berth";
  portContextName?: string;
  terminalContextName?: string;
};

type ParsedSummaryContext = {
  scope: "port" | "terminal" | "berth";
  portContextName?: string;
  terminalContextName?: string;
  berthContextName?: string;
};

type ResultRow = {
  portName: string;
  terminalName?: string;
  berthName?: string;
  matchLabel: string;
  matchValue: string;
  date: string;
};

const NUMERIC_PARAMETER_CONFIG: Array<{
  parameter: NumericParameter;
  label: string;
  aliases: string[];
  family: "length" | "plain" | "rate" | "density";
}> = [
  { parameter: "draft", label: "Draft", aliases: ["draft"], family: "length" },
  { parameter: "loa", label: "LOA", aliases: ["loa", "length overall"], family: "length" },
  { parameter: "beam", label: "Beam", aliases: ["beam"], family: "length" },
  { parameter: "air_draft", label: "Air Draft", aliases: ["air draft"], family: "length" },
  { parameter: "dwt", label: "DWT", aliases: ["dwt", "deadweight"], family: "plain" },
  { parameter: "density", label: "Density", aliases: ["density", "specific gravity", "salinity"], family: "density" },
  { parameter: "load_rate", label: "Load Rate", aliases: ["load rate", "loading rate"], family: "rate" },
  { parameter: "discharge_rate", label: "Discharge Rate", aliases: ["discharge rate", "discharging rate"], family: "rate" },
  { parameter: "gangs", label: "Gangs", aliases: ["gangs", "gang"], family: "plain" },
  { parameter: "shifts", label: "Shifts", aliases: ["shifts", "shift"], family: "plain" },
  { parameter: "ukc", label: "UKC", aliases: ["ukc", "under keel clearance"], family: "length" },
  { parameter: "freeboard", label: "Freeboard", aliases: ["freeboard"], family: "length" },
  { parameter: "trim", label: "Trim", aliases: ["trim"], family: "length" },
  { parameter: "tide", label: "Tide", aliases: ["tide"], family: "length" },
];

const CAPABILITY_FILTERS: Array<{ capability: string; displayLabel: string; aliases: string[] }> = [
  { capability: "grain", displayLabel: "Grain-capable", aliases: ["grain"] },
  { capability: "cement", displayLabel: "Cement-capable", aliases: ["cement"] },
  { capability: "coal", displayLabel: "Coal-capable", aliases: ["coal"] },
  { capability: "petcoke", displayLabel: "Petcoke-capable", aliases: ["petcoke", "pet coke"] },
  { capability: "sulphur", displayLabel: "Sulphur-capable", aliases: ["sulphur", "sulfur"] },
];

const CONDITION_FILTERS: Array<{ token: string; displayLabel: string; aliases: string[] }> = [
  { token: "FW", displayLabel: "FW", aliases: ["fw", "fresh water", "freshwater"] },
  { token: "SW", displayLabel: "SW", aliases: ["sw", "sea water", "seawater", "salt water", "saltwater"] },
  { token: "Brackish", displayLabel: "Brackish", aliases: ["brackish"] },
  { token: "NAABSA", displayLabel: "NAABSA", aliases: ["naabsa"] },
  { token: "Zero tide", displayLabel: "Zero tide", aliases: ["zero tide"] },
  { token: "HW", displayLabel: "HW", aliases: ["hw", "high water"] },
  { token: "LW", displayLabel: "LW", aliases: ["lw", "low water"] },
];

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const systemPrompt = `
You are "Port Assistant" for dry bulk and general cargo operations.

Rules:
- Always distinguish port-level, terminal-level, and berth-level information.
- Never merge berth data into terminal or port data unless the user explicitly asks for a broader summary.
- When the DB contains multiple different values for the same category at the same scope/location, explicitly describe it as value variation or a multi-observation set.
- Do not force a conservative recommendation unless the user explicitly asks for your operational recommendation.
- Draft and density/salinity are linked. If draft values come with different density conditions, explain that clearly instead of flattening them into one number.
- Always cite source name and date for operational facts.
- If data is missing, say so clearly.
- You may make controlled operational inferences when the DB strongly indicates a handling capability. Clearly label it as an inferred capability, not as an explicit raw fact.
- Example: grain elevator / grain loader / grain spout / grain terminal wording is strong evidence that a terminal is grain-capable, even if the raw fact does not literally say "cargo = grain".
- Freight markets and weather routing are outside scope.
- If the user asks for a "Summary overview", do not default to a narrative summary. Prefer a compact evidence format:
  1. every category present in the selected context
  2. repeated values with mention counts
  3. latest 5 mentions with dates
  4. a short evidence note only if useful
- Do not silently skip categories just because they are not core restriction or production categories.
- If a category has only one observation, include it briefly.
- For draft, density, air draft, LOA, beam, DWT, rates, gangs, and shifts, prioritize count-based evidence over prose.
- When the user's question implies selecting or filtering ports on the map, return the matching port names in highlightedPorts.
- Only include port names that exist in the provided DB context.
- For threshold/filter questions like "which ports have draft over 13m", list only the matching ports by default.
- Do not include excluded ports, near misses, or "below threshold" examples unless the user explicitly asks for exclusions or comparison.
- When the user asks about "restrictions", do not limit yourself to facts literally stored under category "restriction".
- In restriction answers, treat vessel-limiting categories as part of the restriction stack: draft, LOA, beam, DWT/deadweight, displacement, air draft, density/salinity when it affects draft, UKC, freeboard, trim, tide constraints, and explicit operational limitation notes.
- Cleaning, bunkering, sulphur, and transit can be included in a restrictions answer when they materially limit operations, but they should come after the core vessel-size / hydro / draft restrictions.
- If a port or terminal has explicit size limits like max draft, max LOA, max beam, or deadweight, those should be surfaced first in a restrictions answer even if there is also a generic "no restriction" note elsewhere.
- For bunkering-location questions, treat anchorage, alongside, truck, and barge as different meanings. Do not collapse them together.
- "Alongside" means bunkering at berth / alongside the vessel. It is not the same as anchorage.
- If the user asks whether bunkering is allowed alongside, a match may include "Bunkering only alongside" or "Bunkering at anchorage or alongside", but not "Bunkering only at anchorage".
- If the user asks whether bunkering is only at anchorage, match only clearly anchorage-only evidence. Do not include mixed or dual-mode arrangements as clean matches.
- If a port has mixed bunker arrangements across terminals or berths, do not flatten that into a clean whole-port answer. Answer at terminal/berth level or explicitly say the port is mixed by location.
- For bunker questions, prefer [BUNKER MODE ...] lines over raw bunker text when both are present.
`.trim();

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "date unknown";
  return new Date(d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function buildBunkerModeContextLines(port: PortForFilters) {
  const lines = port.facts
    .map((fact) => ({
      fact,
      modes: resolvedBunkerModesForFact(fact),
    }))
    .filter((item) => item.modes.size > 0)
    .map((item) => {
      const label = scopeLabel(
        port.name,
        item.fact.scope,
        item.fact.terminal?.name,
        item.fact.berth?.name
      );
      const date = fmtDate(item.fact.sourceRecord?.sourceDate ?? item.fact.createdAt);
      const modeLabel = Array.from(item.modes).map(bunkerModeLabel).join(", ");
      return `  [BUNKER MODE ${item.fact.scope}] ${label} | ${modeLabel} | ${factRawDisplayValue(
        item.fact.value,
        item.fact.unit
      )} (${date})`;
    });

  return lines;
}

function resolvedBunkerModesForFact(fact: Pick<FactForFilters, "category" | "value" | "unit" | "notes" | "rawSnippet">) {
  const normalizedMatch = (fact.notes ?? "")
    .match(/normalized bunker mode:\s*([a-z_]+)/i)?.[1]
    ?.trim()
    .toLowerCase();

  const normalizedModes = new Set<BunkerMode>();
  if (
    normalizedMatch === "anchorage_only" ||
    normalizedMatch === "alongside_only" ||
    normalizedMatch === "anchorage_or_alongside" ||
    normalizedMatch === "truck_only" ||
    normalizedMatch === "barge_only" ||
    normalizedMatch === "not_available" ||
    normalizedMatch === "conditional_mixed"
  ) {
    normalizedModes.add(normalizedMatch);
  }

  const parsedModes = parseBunkerModes({
    category: fact.category,
    value: fact.value,
    unit: fact.unit,
    notes: fact.notes,
    rawSnippet: fact.rawSnippet ?? null,
  });
  const relaxedParsedModes = parseBunkerModes({
    category: null,
    value: fact.value,
    unit: fact.unit,
    notes: fact.notes,
    rawSnippet: fact.rawSnippet ?? null,
  });

  if (normalizedModes.size === 0) {
    return new Set<BunkerMode>([
      ...Array.from(parsedModes),
      ...Array.from(relaxedParsedModes),
    ]);
  }

  return new Set<BunkerMode>([
    ...Array.from(normalizedModes),
    ...Array.from(parsedModes),
    ...Array.from(relaxedParsedModes),
  ]);
}

function isBunkerQuestion(question: string) {
  return /\bbunker(?:ing|s?)\b|\bfuell?ing\b|\brefuel(?:ling|ing)?\b/i.test(question);
}

function bunkerQuestionInstruction(question: string) {
  if (!isBunkerQuestion(question)) return "";

  const normalized = question.trim().toLowerCase();
  const asksAnchorageOnly =
    /\bonly at anchorage\b|\bat anchorage only\b|\banchorage only\b/.test(normalized);
  const asksAlongside =
    /\balongside\b|\bat berth\b/.test(normalized);
  const asksOnly = /\bonly\b/.test(normalized);

  const scopedRules = [
    "Bunker-question rules:",
    "- Use normalized bunker-mode evidence as the primary grounding when available.",
    "- Keep port-level, terminal-level, and berth-level bunker answers separate.",
  ];

  if (asksAnchorageOnly) {
    scopedRules.push(
      '- The user is asking for anchorage-only bunkering. Match only "Bunkering only at anchorage".',
      '- Do not include "Bunkering at anchorage or alongside", truck-only, barge-only, or conditional / mixed arrangements as clean matches.'
    );
  }

  if (asksAlongside && !asksOnly) {
    scopedRules.push(
      '- The user is asking whether bunkering is allowed alongside. Include "Bunkering only alongside" and "Bunkering at anchorage or alongside".',
      '- Do not describe an anchorage-only arrangement as allowing alongside bunkering.'
    );
  }

  if (asksAlongside && asksOnly) {
    scopedRules.push(
      '- The user is asking for alongside-only bunkering. Match only "Bunkering only alongside".',
      '- Do not include mixed anchorage/alongside arrangements.'
    );
  }

  return `\n\n${scopedRules.join("\n")}`;
}

function isRestrictionQuestion(question: string) {
  return /\brestrictions?\b|limitation|limitations|limits?|max draft|max loa|max beam|deadweight|dwt/i.test(
    question
  );
}

function restrictionQuestionInstruction(question: string) {
  if (!isRestrictionQuestion(question)) return "";

  return `

Restriction-answer rules:
- The user is asking about restrictions / operational limits.
- Build the answer as a restriction stack, not as a generic narrative.
- Surface core vessel and hydro limits first: draft, LOA, beam, DWT/deadweight, displacement, air draft, density, UKC, freeboard, trim, tide.
- Do not rely only on facts in category "restriction"; include any relevant limiting values from draft/loa/beam/dwt/density/etc.
- If there is a generic "no restriction" note but also explicit max draft / LOA / beam / deadweight values, treat the explicit numeric limits as the main restriction answer.
- Only after the core size / draft restrictions, mention secondary operating restrictions like cleaning, bunkering, sulphur, or transit.
`.trimEnd();
}

function parseRestrictionQuestion(
  question: string,
  ports: PortForFilters[]
): ParsedRestrictionQuestion | null {
  if (!isRestrictionQuestion(question) || isSummaryOverviewRequest(question)) return null;

  const portContextName = detectPortContext(question, ports);
  const terminalContextName = detectTerminalContext(question, ports);
  let scope: "port" | "terminal" | "berth" = "port";
  if (/\bberths?\b|\bpiers?\b|\bjetties\b|причал/i.test(question)) scope = "berth";
  else if (/\bterminals?\b|терминал/i.test(question) || terminalContextName) scope = "terminal";

  if (!portContextName && !terminalContextName) return null;

  return {
    scope,
    portContextName: portContextName ?? undefined,
    terminalContextName: terminalContextName ?? undefined,
  };
}

function isSecondaryRestrictionFact(fact: FactForFilters) {
  const category = fact.category.trim().toLowerCase();
  return ["cleaning", "bunker", "sulphur", "transit", "restriction"].includes(category);
}

function isRestrictionOtherFact(fact: FactForFilters) {
  const category = fact.category.trim().toLowerCase();
  if (category !== "other") return false;
  const haystack = factHaystack(fact);
  return (
    /\brestrict/i.test(haystack) ||
    /\bcleaning\b/.test(haystack) ||
    /\bbunker/i.test(haystack) ||
    /\bsulphur\b|\bsulfur\b/.test(haystack) ||
    /\btransit\b/.test(haystack) ||
    /\bdisplacement\b/.test(haystack)
  );
}

function restrictionLocationLabel(
  portName: string,
  fact: FactForFilters,
  requestedScope: "port" | "terminal" | "berth"
) {
  if (requestedScope === "berth") {
    return [fact.terminal?.name, fact.berth?.name].filter(Boolean).join(" > ") || portName;
  }
  if (requestedScope === "terminal") {
    return fact.terminal?.name ?? portName;
  }
  return scopeLabel(portName, fact.scope, fact.terminal?.name, fact.berth?.name);
}

function restrictionScopeLabel(fact: FactForFilters) {
  if (fact.scope === PortFactScope.BERTH) return "Berth-specific";
  if (fact.scope === PortFactScope.TERMINAL) return "Terminal-specific";
  return "Port-level";
}

function collectRestrictionFactsWithInheritance(args: {
  port: PortForFilters;
  query: ParsedRestrictionQuestion;
  predicate: (fact: FactForFilters) => boolean;
}) {
  const allFacts = args.port.facts.filter(args.predicate);

  if (args.query.scope === "port") {
    return {
      facts: allFacts,
      inherited: false,
    };
  }

  if (args.query.scope === "terminal") {
    const terminalFacts = allFacts.filter(
      (fact) =>
        (fact.terminal?.name ?? "").toLowerCase() === (args.query.terminalContextName ?? "").toLowerCase()
    );
    if (terminalFacts.length > 0) {
      return {
        facts: terminalFacts,
        inherited: false,
      };
    }

    const portFacts = allFacts.filter((fact) => fact.scope === PortFactScope.PORT);
    return {
      facts: portFacts,
      inherited: portFacts.length > 0,
    };
  }

  const berthFacts = allFacts.filter(
    (fact) =>
      Boolean(fact.berth?.name) &&
      (fact.terminal?.name ?? "").toLowerCase() === (args.query.terminalContextName ?? "").toLowerCase()
  );
  if (berthFacts.length > 0) {
    return {
      facts: berthFacts,
      inherited: false,
    };
  }

  const terminalFacts = allFacts.filter(
    (fact) =>
      Boolean(fact.terminal?.name) &&
      (fact.terminal?.name ?? "").toLowerCase() === (args.query.terminalContextName ?? "").toLowerCase() &&
      fact.scope !== PortFactScope.PORT
  );
  if (terminalFacts.length > 0) {
    return {
      facts: terminalFacts,
      inherited: true,
    };
  }

  const portFacts = allFacts.filter((fact) => fact.scope === PortFactScope.PORT);
  return {
    facts: portFacts,
    inherited: portFacts.length > 0,
  };
}

function summaryCategoryKey(fact: FactForFilters) {
  const derived = deriveFilterCategory(fact);
  if (derived) return derived;
  return fact.category.trim().toLowerCase();
}

function summaryCategoryLabel(categoryKey: string) {
  const numeric = NUMERIC_PARAMETER_CONFIG.find((item) => item.parameter === categoryKey);
  if (numeric) return numeric.label;

  const labelMap = new Map<string, string>([
    ["equipment", "Equipment"],
    ["cargo", "Cargo"],
    ["bunker", "Bunkering"],
    ["cleaning", "Cleaning"],
    ["sulphur", "Sulphur"],
    ["survey", "Survey"],
    ["transit", "Transit"],
    ["restriction", "Operational Notes"],
    ["other", "Other"],
  ]);
  return labelMap.get(categoryKey) ?? categoryKey.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function summaryCategoryOrder(categoryKey: string) {
  const order = [
    "draft",
    "loa",
    "beam",
    "density",
    "air_draft",
    "dwt",
    "ukc",
    "freeboard",
    "trim",
    "tide",
    "load_rate",
    "discharge_rate",
    "shifts",
    "gangs",
    "equipment",
    "cargo",
    "restriction",
    "bunker",
    "cleaning",
    "sulphur",
    "survey",
    "transit",
    "other",
  ];
  const index = order.indexOf(categoryKey);
  return index === -1 ? 999 : index;
}

function collectSummaryFactsWithInheritance(args: {
  port: PortForFilters;
  query: ParsedSummaryContext;
  categoryKey: string;
}) {
  const categoryFacts = args.port.facts.filter((fact) => summaryCategoryKey(fact) === args.categoryKey);

  if (args.query.scope === "port") {
    return {
      facts: categoryFacts,
      inheritedFrom: null as null | "port" | "terminal",
    };
  }

  if (args.query.scope === "terminal") {
    const terminalFacts = categoryFacts.filter(
      (fact) =>
        (fact.terminal?.name ?? "").toLowerCase() === (args.query.terminalContextName ?? "").toLowerCase()
    );
    if (terminalFacts.length > 0) {
      return {
        facts: terminalFacts,
        inheritedFrom: null as null | "port" | "terminal",
      };
    }

    const portFacts = categoryFacts.filter((fact) => fact.scope === PortFactScope.PORT);
    return {
      facts: portFacts,
      inheritedFrom: portFacts.length > 0 ? ("port" as const) : null,
    };
  }

  const berthFacts = categoryFacts.filter(
    (fact) =>
      (fact.berth?.name ?? "").toLowerCase() === (args.query.berthContextName ?? "").toLowerCase()
  );
  if (berthFacts.length > 0) {
    return {
      facts: berthFacts,
      inheritedFrom: null as null | "port" | "terminal",
    };
  }

  const terminalFacts = categoryFacts.filter(
    (fact) =>
      (fact.terminal?.name ?? "").toLowerCase() === (args.query.terminalContextName ?? "").toLowerCase() &&
      fact.scope !== PortFactScope.PORT
  );
  if (terminalFacts.length > 0) {
    return {
      facts: terminalFacts,
      inheritedFrom: "terminal" as const,
    };
  }

  const portFacts = categoryFacts.filter((fact) => fact.scope === PortFactScope.PORT);
  return {
    facts: portFacts,
    inheritedFrom: portFacts.length > 0 ? ("port" as const) : null,
  };
}

function summaryInheritanceLabel(inheritedFrom: null | "port" | "terminal") {
  if (inheritedFrom === "port") return "Inherited from port";
  if (inheritedFrom === "terminal") return "Inherited from terminal";
  return null;
}

function summaryEffectiveContextLabel(
  portName: string,
  fact: FactForFilters,
  query: ParsedSummaryContext
) {
  if (query.scope === "terminal") {
    return (fact.terminal?.name ?? fact.berth?.name ?? portName).trim().toLowerCase();
  }
  if (query.scope === "berth") {
    return (fact.berth?.name ?? fact.terminal?.name ?? portName).trim().toLowerCase();
  }
  return portName.trim().toLowerCase();
}

function summaryDisplayValueForCategory(categoryKey: string, fact: FactForFilters) {
  const numericConfig = NUMERIC_PARAMETER_CONFIG.find((item) => item.parameter === categoryKey);
  if (numericConfig) {
    return restrictionDisplayValue({
      fact,
      parameter: categoryKey as NumericParameter,
    });
  }
  return factRawDisplayValue(fact.value, fact.unit);
}

function dedupeSummaryFacts(args: {
  portName: string;
  query: ParsedSummaryContext;
  categoryKey: string;
  facts: FactForFilters[];
}) {
  const deduped = new Map<string, FactForFilters>();

  for (const fact of args.facts) {
    const displayValue = summaryDisplayValueForCategory(args.categoryKey, fact);
    const dedupeKey = [
      fact.sourceRecord?.sourceDate?.toISOString() ?? fact.createdAt.toISOString(),
      summaryEffectiveContextLabel(args.portName, fact, args.query),
      args.categoryKey,
      displayValue.toLowerCase(),
      fact.sourceRecord ? "with_source" : "no_source",
    ].join("::");

    const existing = deduped.get(dedupeKey);
    if (!existing) {
      deduped.set(dedupeKey, fact);
      continue;
    }

    const existingScopeRank =
      existing.scope === PortFactScope.BERTH ? 3 : existing.scope === PortFactScope.TERMINAL ? 2 : 1;
    const nextScopeRank =
      fact.scope === PortFactScope.BERTH ? 3 : fact.scope === PortFactScope.TERMINAL ? 2 : 1;

    if (nextScopeRank > existingScopeRank) {
      deduped.set(dedupeKey, fact);
    }
  }

  return Array.from(deduped.values());
}

function buildSummaryOverviewAnswer(args: {
  ports: PortForFilters[];
  query: ParsedSummaryContext;
}) {
  const targetPort = args.ports.find((port) =>
    args.query.portContextName
      ? port.name.toLowerCase() === args.query.portContextName.toLowerCase()
      : true
  );

  if (!targetPort) {
    return {
      answer: "No matching summary context found.",
      highlightedPorts: [] as string[],
      matchedLocations: [] as MatchedLocation[],
      resultRows: [] as ResultRow[],
    };
  }

  const allCategoryKeys = Array.from(
    new Set(targetPort.facts.map((fact) => summaryCategoryKey(fact)))
  ).sort((a, b) => summaryCategoryOrder(a) - summaryCategoryOrder(b) || a.localeCompare(b));

  const answerLines: string[] = [];
  const matchedLocations: MatchedLocation[] = [];
  const resultRows: ResultRow[] = [];

  const header =
    args.query.scope === "berth"
      ? `Summary overview for ${args.query.berthContextName}${args.query.terminalContextName ? ` in ${args.query.terminalContextName}` : ""}, ${targetPort.name}:`
      : args.query.scope === "terminal"
        ? `Summary overview for ${args.query.terminalContextName} at ${targetPort.name}:`
        : `Summary overview for ${targetPort.name}${targetPort.country ? `, ${targetPort.country}` : ""}:`;
  answerLines.push(header);

  for (const categoryKey of allCategoryKeys) {
    const { facts, inheritedFrom } = collectSummaryFactsWithInheritance({
      port: targetPort,
      query: args.query,
      categoryKey,
    });
    if (facts.length === 0) continue;

    const dedupedFacts = dedupeSummaryFacts({
      portName: targetPort.name,
      query: args.query,
      categoryKey,
      facts,
    });

    const counts = new Map<string, number>();
    const countOrder = new Map<string, number>();
    const sortedFacts = [...dedupedFacts].sort((a, b) => {
      const aTime = a.sourceRecord?.sourceDate?.getTime() ?? a.createdAt.getTime();
      const bTime = b.sourceRecord?.sourceDate?.getTime() ?? b.createdAt.getTime();
      return bTime - aTime;
    });

    for (const fact of sortedFacts) {
      const displayValue = summaryDisplayValueForCategory(categoryKey, fact);
      if (!countOrder.has(displayValue)) countOrder.set(displayValue, countOrder.size);
      counts.set(displayValue, (counts.get(displayValue) ?? 0) + 1);
    }

    const repeatedValueLines = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || (countOrder.get(a[0]) ?? 0) - (countOrder.get(b[0]) ?? 0))
      .map(([value, count]) => `- ${value} — ${count} mention${count === 1 ? "" : "s"}`);

    const latestMentionLines = sortedFacts.slice(0, 5).map((fact) => {
      const displayValue = summaryDisplayValueForCategory(categoryKey, fact);
      const date = fmtDate(fact.sourceRecord?.sourceDate ?? fact.createdAt);
      const notePart = fact.notes ? ` (${fact.notes})` : "";
      return `- ${displayValue}${notePart} — ${date}`;
    });

    const inheritanceLabel = summaryInheritanceLabel(inheritedFrom);
    answerLines.push(`${summaryCategoryLabel(categoryKey)}${inheritanceLabel ? ` [${inheritanceLabel}]` : ""}:`);
    answerLines.push(...repeatedValueLines);
    answerLines.push("Latest 5 mentions:");
    answerLines.push(...latestMentionLines);

    const distinctValues = counts.size;
    if (distinctValues > 1) {
      answerLines.push(`Evidence note: ${distinctValues} distinct values recorded for this category.`);
    }

    const representativeFact = sortedFacts[0];
    matchedLocations.push(
      matchedLocationForScope(
        targetPort.name,
        targetPort.country,
        representativeFact,
        args.query.scope
      )
    );
    resultRows.push({
      portName: targetPort.name,
      terminalName: representativeFact.terminal?.name ?? undefined,
      berthName: args.query.scope === "berth" ? representativeFact.berth?.name ?? undefined : undefined,
      matchLabel: `${summaryCategoryLabel(categoryKey)} summary`,
      matchValue: repeatedValueLines[0]?.replace(/^- /, "") ?? summaryCategoryLabel(categoryKey),
      date: fmtDate(representativeFact.sourceRecord?.sourceDate ?? representativeFact.createdAt),
    });
  }

  return {
    answer: answerLines.join("\n"),
    highlightedPorts: [targetPort.name],
    matchedLocations: Array.from(
      new Map(
        matchedLocations.map((item) => [
          `${item.portName}__${item.portCountry ?? ""}__${item.terminalName ?? ""}__${item.berthName ?? ""}`,
          item,
        ])
      ).values()
    ),
    resultRows,
  };
}

function matchesRestrictionCoreParameter(
  fact: FactForFilters,
  parameter: NumericParameter
) {
  const base = fact.category.trim().toLowerCase();
  const haystack = factHaystack(fact);

  if (parameter === "draft") {
    return base === "draft" || /\bmax draft\b|\bmaximum draft\b|\bdraft alongside\b|\bdraft along side\b/.test(haystack);
  }
  if (parameter === "loa") {
    return base === "loa" || /\bloa\b|\blength overall\b/.test(haystack);
  }
  if (parameter === "beam") {
    return base === "beam" || /\bbeam\b/.test(haystack);
  }
  if (parameter === "dwt") {
    return base === "dwt" || /\bdwt\b|\bdeadweight\b/.test(haystack);
  }
  if (parameter === "density") {
    return base === "density" || /\bdensity\b|\bspecific gravity\b|\bsalinity\b/.test(haystack);
  }
  if (parameter === "air_draft") {
    return base === "air_draft" || /\bair draft\b/.test(haystack);
  }
  if (parameter === "ukc") {
    return base === "ukc" || /\bukc\b|under keel clearance/.test(haystack);
  }
  if (parameter === "freeboard") {
    return base === "freeboard" || /\bfreeboard\b/.test(haystack);
  }
  if (parameter === "trim") {
    return base === "trim" || /\btrim\b/.test(haystack);
  }
  if (parameter === "tide") {
    return base === "tide" || /\btide\b|\bmllw\b|\bmlws\b|\bhigh water\b|\blow water\b/.test(haystack);
  }
  return false;
}

function restrictionDisplayValue(args: {
  fact: FactForFilters;
  parameter: NumericParameter;
}) {
  const family =
    NUMERIC_PARAMETER_CONFIG.find((item) => item.parameter === args.parameter)?.family ?? "plain";

  const valueHasNumber = /\d/.test(args.fact.value);
  const unitHasLengthHint = /\bm\b|\bft\b|\bfeet\b|\bfoot\b/i.test(args.fact.unit ?? "");

  if (
    (args.parameter === "draft" ||
      args.parameter === "loa" ||
      args.parameter === "beam" ||
      args.parameter === "air_draft" ||
      args.parameter === "ukc" ||
      args.parameter === "freeboard" ||
      args.parameter === "trim") &&
    !valueHasNumber &&
    !unitHasLengthHint
  ) {
    return args.fact.value.trim();
  }

  if (
    (args.parameter === "draft" ||
      args.parameter === "loa" ||
      args.parameter === "beam" ||
      args.parameter === "air_draft" ||
      args.parameter === "ukc" ||
      args.parameter === "freeboard" ||
      args.parameter === "trim") &&
    !valueHasNumber &&
    args.fact.category.trim().toLowerCase() === "restriction"
  ) {
    return args.fact.value.trim();
  }

  const numericValue = parseNumericMeters(
    {
      value: args.fact.value,
      unit: args.fact.unit,
      notes: args.fact.notes,
      rawSnippet: args.fact.rawSnippet ?? null,
    },
    family
  );

  if (typeof numericValue !== "number" || !Number.isFinite(numericValue)) {
    return factRawDisplayValue(args.fact.value, args.fact.unit);
  }

  return formatFactValueForDeterministicAnswer({
    fact: args.fact,
    numericValue,
    family,
  });
}

function buildRestrictionAnswer(args: {
  ports: PortForFilters[];
  query: ParsedRestrictionQuestion;
}) {
  const coreCategories: Array<{ parameter: NumericParameter; label: string }> = [
    { parameter: "draft", label: "Draft" },
    { parameter: "loa", label: "LOA" },
    { parameter: "beam", label: "Beam" },
    { parameter: "dwt", label: "DWT / Deadweight" },
    { parameter: "density", label: "Density" },
    { parameter: "air_draft", label: "Air Draft" },
    { parameter: "ukc", label: "UKC" },
    { parameter: "freeboard", label: "Freeboard" },
    { parameter: "trim", label: "Trim" },
    { parameter: "tide", label: "Tide" },
  ];

  const secondaryLabels = new Map<string, string>([
    ["cleaning", "Cleaning"],
    ["bunker", "Bunkering"],
    ["sulphur", "Sulphur"],
    ["transit", "Transit"],
    ["restriction", "Operational Notes"],
    ["other", "Other Restrictions"],
  ]);

  const matchedLocations: MatchedLocation[] = [];
  const resultRows: ResultRow[] = [];
  const answerLines: string[] = [];

  const targetPorts = args.ports.filter((port) =>
    args.query.portContextName
      ? port.name.toLowerCase() === args.query.portContextName.toLowerCase()
      : true
  );

  if (targetPorts.length === 0) {
    return {
      answer: "No matching port context found for this restrictions question.",
      highlightedPorts: [] as string[],
      matchedLocations: [] as MatchedLocation[],
      resultRows: [] as ResultRow[],
    };
  }

  for (const port of targetPorts) {
    const coreSections: string[] = [];
    const missingCoreLabels: string[] = [];

    for (const config of coreCategories) {
      const { facts, inherited } = collectRestrictionFactsWithInheritance({
        port,
        query: args.query,
        predicate: (fact) => matchesRestrictionCoreParameter(fact, config.parameter),
      });

      const sortedFacts = facts
        .sort((a, b) => {
          const aTime = a.sourceRecord?.sourceDate?.getTime() ?? a.createdAt.getTime();
          const bTime = b.sourceRecord?.sourceDate?.getTime() ?? b.createdAt.getTime();
          return bTime - aTime;
        });

      if (sortedFacts.length === 0) {
        missingCoreLabels.push(config.label);
        continue;
      }

      const seen = new Set<string>();
      const lines: string[] = [];

      for (const fact of sortedFacts) {
        const valueKey = `${fact.value}__${fact.unit ?? ""}__${fact.notes ?? ""}__${fact.terminal?.name ?? ""}__${fact.berth?.name ?? ""}`;
        if (seen.has(valueKey)) continue;
        seen.add(valueKey);

        const formattedValue = restrictionDisplayValue({
          fact,
          parameter: config.parameter,
        });
        const location = restrictionLocationLabel(port.name, fact, args.query.scope);
        const date = fmtDate(fact.sourceRecord?.sourceDate ?? fact.createdAt);
        const notePart = fact.notes ? ` (${fact.notes})` : "";
        const scopePart = inherited ? ` [${restrictionScopeLabel(fact)} applies]` : "";
        lines.push(`  - ${location} — ${formattedValue}${notePart}${scopePart} (${date})`);

        matchedLocations.push(matchedLocationForScope(port.name, port.country, fact, args.query.scope));
        resultRows.push({
          portName: port.name,
          terminalName: fact.terminal?.name ?? undefined,
          berthName: args.query.scope === "berth" ? fact.berth?.name ?? undefined : undefined,
          matchLabel: `${config.label} restriction`,
          matchValue: formattedValue,
          date,
        });

        if (lines.length >= 4) break;
      }

      if (lines.length > 0) {
        coreSections.push(`${config.label}:\n${lines.join("\n")}`);
      }
    }

    const { facts: secondaryFacts } = collectRestrictionFactsWithInheritance({
      port,
      query: args.query,
      predicate: (fact) => isSecondaryRestrictionFact(fact) || isRestrictionOtherFact(fact),
    });
    const sortedSecondaryFacts = secondaryFacts
      .sort((a, b) => {
        const aTime = a.sourceRecord?.sourceDate?.getTime() ?? a.createdAt.getTime();
        const bTime = b.sourceRecord?.sourceDate?.getTime() ?? b.createdAt.getTime();
        return bTime - aTime;
      });

    const secondaryGroups = new Map<string, string[]>();
    for (const fact of sortedSecondaryFacts) {
      const label = secondaryLabels.get(fact.category.trim().toLowerCase()) ?? "Other Restrictions";
      if (!secondaryGroups.has(label)) secondaryGroups.set(label, []);
      const lines = secondaryGroups.get(label)!;
      const location = restrictionLocationLabel(port.name, fact, args.query.scope);
      const date = fmtDate(fact.sourceRecord?.sourceDate ?? fact.createdAt);
      const displayValue = factRawDisplayValue(fact.value, fact.unit);
      const notePart = fact.notes ? ` (${fact.notes})` : "";
      const inherited =
        args.query.scope !== "port" &&
        ((args.query.scope === "terminal" && fact.scope === PortFactScope.PORT) ||
          (args.query.scope === "berth" &&
            ((fact.scope === PortFactScope.TERMINAL && (fact.terminal?.name ?? "").toLowerCase() === (args.query.terminalContextName ?? "").toLowerCase()) ||
              fact.scope === PortFactScope.PORT)));
      const scopePart = inherited ? ` [${restrictionScopeLabel(fact)} applies]` : "";
      const line = `  - ${location} — ${displayValue}${notePart}${scopePart} (${date})`;
      if (!lines.includes(line)) lines.push(line);
    }

    answerLines.push(
      `${args.query.scope === "terminal" && args.query.terminalContextName ? `Restrictions for ${args.query.terminalContextName} at ${port.name}${port.country ? `, ${port.country}` : ""}` : `Restrictions for ${port.name}${port.country ? `, ${port.country}` : ""}`}:`
    );

    if (coreSections.length > 0) {
      answerLines.push(
        args.query.scope === "terminal" && args.query.terminalContextName
          ? "Core vessel / hydro restrictions applicable to this terminal:"
          : args.query.scope === "berth"
            ? "Core vessel / hydro restrictions applicable to this berth:"
            : "Core vessel / hydro restrictions:"
      );
      answerLines.push(...coreSections);
    } else {
      answerLines.push("Core vessel / hydro restrictions: No explicit draft / LOA / beam / DWT-style limits found.");
    }

    if (missingCoreLabels.length > 0) {
      answerLines.push(`Not explicitly stated: ${missingCoreLabels.join(", ")}.`);
    }

    if (secondaryGroups.size > 0) {
      answerLines.push("Secondary operating restrictions:");
      for (const [label, lines] of secondaryGroups.entries()) {
        answerLines.push(`${label}:`);
        answerLines.push(...lines.slice(0, 4));
      }
    }
  }

  return {
    answer: answerLines.join("\n"),
    highlightedPorts: Array.from(new Set(targetPorts.map((port) => port.name))),
    matchedLocations: Array.from(
      new Map(
        matchedLocations.map((item) => [
          `${item.portName}__${item.portCountry ?? ""}__${item.terminalName ?? ""}__${item.berthName ?? ""}`,
          item,
        ])
      ).values()
    ),
    resultRows: Array.from(
      new Map(
        resultRows.map((row) => [
          `${row.portName}__${row.terminalName ?? ""}__${row.berthName ?? ""}__${row.matchLabel}__${row.matchValue}`,
          row,
        ])
      ).values()
    ),
  };
}

function parseBunkerQuestion(
  question: string,
  ports: PortForFilters[]
): ParsedBunkerQuestion | null {
  if (!isBunkerQuestion(question)) return null;

  const normalized = question.trim().toLowerCase();
  let intent: BunkerIntent | null = null;

  if (/\bnot available\b|\bno bunkers?\b/.test(normalized)) {
    intent = "not_available";
  } else if (/\bmixed\b|\bconditional\b/.test(normalized)) {
    intent = "mixed";
  } else if (/\bbarge only\b|\bby barge only\b/.test(normalized)) {
    intent = "barge_only";
  } else if (/\bonly alongside\b|\balongside only\b/.test(normalized)) {
    intent = "alongside_only";
  } else if (/\bonly at anchorage\b|\bat anchorage only\b|\banchorage only\b/.test(normalized)) {
    intent = "anchorage_only";
  } else if (/\ballow\b.*\balongside\b|\balongside\b/.test(normalized)) {
    intent = "alongside_allowed";
  }

  if (!intent) return null;

  let scope: "port" | "terminal" | "berth" = "port";
  if (/\bterminals?\b|терминал/i.test(question)) scope = "terminal";
  else if (/\bberths?\b|\bpiers?\b|\bjetties\b|причал/i.test(question)) scope = "berth";

  return {
    intent,
    scope,
    portContextName: detectPortContext(question, ports),
    terminalContextName: detectTerminalContext(question, ports),
  };
}

function isQueryableBunkerLocationFact(
  fact: Pick<FactForFilters, "category" | "value" | "unit" | "notes" | "rawSnippet">
) {
  if (
    isBunkerLocationFact({
      category: fact.category,
      value: fact.value,
      unit: fact.unit,
      notes: fact.notes,
      rawSnippet: fact.rawSnippet ?? null,
    })
  ) {
    return true;
  }

  return isBunkerLocationFact({
    category: null,
    value: fact.value,
    unit: fact.unit,
    notes: fact.notes,
    rawSnippet: fact.rawSnippet ?? null,
  });
}

function bunkerIntentMatches(intent: BunkerIntent, modes: Set<BunkerMode>) {
  if (intent === "anchorage_only") {
    return modes.has("anchorage_only") && !modes.has("conditional_mixed");
  }
  if (intent === "alongside_allowed") {
    return modes.has("alongside_only") || modes.has("anchorage_or_alongside");
  }
  if (intent === "alongside_only") {
    return modes.has("alongside_only") && !modes.has("conditional_mixed");
  }
  if (intent === "barge_only") {
    return modes.has("barge_only");
  }
  if (intent === "not_available") {
    return modes.has("not_available");
  }
  return modes.has("conditional_mixed");
}

function bunkerIntentLabel(intent: BunkerIntent) {
  if (intent === "anchorage_only") return "Bunkering only at anchorage";
  if (intent === "alongside_allowed") return "Bunkering allowed alongside";
  if (intent === "alongside_only") return "Bunkering only alongside";
  if (intent === "barge_only") return "Bunkering by barge only";
  if (intent === "not_available") return "No bunkers available";
  return "Conditional / mixed bunkering arrangement";
}

function bunkerLocationLabel(
  portName: string,
  fact: FactForFilters,
  requestedScope: "port" | "terminal" | "berth"
) {
  if (requestedScope === "berth") {
    return [fact.terminal?.name, fact.berth?.name].filter(Boolean).join(" > ") || portName;
  }
  if (requestedScope === "terminal") {
    return fact.terminal?.name || (fact.berth?.name ? [fact.terminal?.name, fact.berth?.name].filter(Boolean).join(" > ") : portName);
  }
  if (fact.scope === PortFactScope.PORT) return portName;
  if (fact.scope === PortFactScope.TERMINAL) return fact.terminal?.name || portName;
  return [fact.terminal?.name, fact.berth?.name].filter(Boolean).join(" > ") || portName;
}

function buildBunkerAnswer(args: {
  ports: PortForFilters[];
  query: ParsedBunkerQuestion;
}) {
  const rows: Array<{
    portName: string;
    portCountry?: string;
    locationLabel: string;
    fact: FactForFilters;
    modes: Set<BunkerMode>;
    date: string;
  }> = [];

  for (const port of args.ports) {
    if (
      args.query.portContextName &&
      port.name.toLowerCase() !== args.query.portContextName.toLowerCase()
    ) {
      continue;
    }

    for (const fact of port.facts) {
      if (!isQueryableBunkerLocationFact(fact)) {
        continue;
      }
      if (
        args.query.terminalContextName &&
        (fact.terminal?.name ?? "").toLowerCase() !== args.query.terminalContextName.toLowerCase()
      ) {
        continue;
      }

      const modes = resolvedBunkerModesForFact(fact);
      if (!modes.size || !bunkerIntentMatches(args.query.intent, modes)) continue;

      if (args.query.scope === "terminal" && !fact.terminal?.name) continue;
      if (args.query.scope === "berth" && !fact.berth?.name) continue;

      rows.push({
        portName: port.name,
        portCountry: port.country ?? undefined,
        locationLabel: bunkerLocationLabel(port.name, fact, args.query.scope),
        fact,
        modes,
        date: fmtDate(fact.sourceRecord?.sourceDate ?? fact.createdAt),
      });
    }
  }

  const dedupedRows = Array.from(
    new Map(
      rows.map((row) => [
        `${row.portName}__${row.portCountry ?? ""}__${row.locationLabel.toLowerCase()}__${Array.from(row.modes).sort().join(",")}`,
        row,
      ])
    ).values()
  ).sort((a, b) => a.portName.localeCompare(b.portName) || a.locationLabel.localeCompare(b.locationLabel));

  if (dedupedRows.length === 0) {
    return {
      answer: `No ports in the current Port Intelligence DB match: ${bunkerIntentLabel(args.query.intent)}.`,
      highlightedPorts: [] as string[],
      matchedLocations: [] as MatchedLocation[],
      resultRows: [] as ResultRow[],
    };
  }

  const grouped = new Map<string, typeof dedupedRows>();
  for (const row of dedupedRows) {
    const key = `${row.portName}__${row.portCountry ?? ""}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row);
  }

  const answerLines: string[] = [];
  const resultRows: ResultRow[] = [];
  const matchedLocations: MatchedLocation[] = [];

  const scopeIntro =
    args.query.scope === "terminal"
      ? `Terminals with ${bunkerIntentLabel(args.query.intent).toLowerCase()}:`
      : args.query.scope === "berth"
        ? `Berths with ${bunkerIntentLabel(args.query.intent).toLowerCase()}:`
        : `Ports with ${bunkerIntentLabel(args.query.intent).toLowerCase()}:`;

  answerLines.push(scopeIntro);

  for (const [groupKey, portRows] of grouped.entries()) {
    void groupKey;
    const first = portRows[0];
    answerLines.push(`- ${first.portName}${first.portCountry ? `, ${first.portCountry}` : ""}:`);

    for (const row of portRows) {
      const modeLabel = Array.from(row.modes).map(bunkerModeLabel).join(", ");
      const displayValue = factRawDisplayValue(row.fact.value, row.fact.unit);
      const notePart = row.fact.notes ? ` (${row.fact.notes})` : "";
      answerLines.push(`  - ${row.locationLabel} — ${modeLabel}; raw: ${displayValue}${notePart} (${row.date})`);
      matchedLocations.push(
        matchedLocationForScope(
          row.portName,
          row.portCountry,
          row.fact,
          args.query.scope
        )
      );
      resultRows.push({
        portName: row.portName,
        terminalName: row.fact.terminal?.name ?? undefined,
        berthName: args.query.scope === "berth" ? row.fact.berth?.name ?? undefined : undefined,
        matchLabel: bunkerIntentLabel(args.query.intent),
        matchValue: modeLabel,
        date: row.date,
      });
    }
  }

  return {
    answer: answerLines.join("\n"),
    highlightedPorts: Array.from(new Set(dedupedRows.map((row) => row.portName))),
    matchedLocations: Array.from(
      new Map(
        matchedLocations.map((item) => [
          `${item.portName}__${item.portCountry ?? ""}__${item.terminalName ?? ""}__${item.berthName ?? ""}`,
          item,
        ])
      ).values()
    ),
    resultRows: Array.from(
      new Map(
        resultRows.map((row) => [
          `${row.portName}__${row.terminalName ?? ""}__${row.berthName ?? ""}__${row.matchLabel}__${row.matchValue}`,
          row,
        ])
      ).values()
    ),
  };
}

function scopeLabel(
  portName: string,
  scope: PortFactScope,
  terminalName: string | null | undefined,
  berthName: string | null | undefined
): string {
  if (scope === PortFactScope.BERTH) {
    return [portName, terminalName, berthName].filter(Boolean).join(" > ");
  }
  if (scope === PortFactScope.TERMINAL) {
    return [portName, terminalName].filter(Boolean).join(" > ");
  }
  return portName;
}

function observationDisplayValue(args: {
  category: string;
  value: string;
  unit: string | null;
  notes: string | null;
}) {
  const parsedConditions = parseOperationalConditions(
    args.value,
    args.unit,
    args.notes
  );
  const conditionTags = conditionTagsFromParsed(parsedConditions);
  const base = `${args.value}${args.unit ? ` ${args.unit}` : ""}`.trim();

  const normalizedConditionTags = conditionTags
    .filter((tag) => !tag.startsWith("Tide "))
    .filter((tag) => !tag.startsWith("Density "))
    .sort((a, b) => a.localeCompare(b));

  if (normalizedConditionTags.length === 0) return base;
  return `${base} [${normalizedConditionTags.join(", ")}]`;
}

function factRawDisplayValue(value: string, unit: string | null) {
  const normalizedValue = value.trim();
  const normalizedUnit = (unit ?? "").trim();
  if (!normalizedUnit) return normalizedValue;

  const lowerValue = normalizedValue.toLowerCase();
  const lowerUnit = normalizedUnit.toLowerCase();
  if (lowerValue.includes(lowerUnit)) return normalizedValue;

  const unitAliases =
    lowerUnit === "m"
      ? [" meter", " meters", " metre", " metres"]
      : lowerUnit === "ft"
        ? [" foot", " feet", " ft"]
        : [];
  if (unitAliases.some((alias) => lowerValue.includes(alias.trim()))) return normalizedValue;

  return `${normalizedValue} ${normalizedUnit}`.trim();
}

function detectRateUnit(value: string, unit: string | null, notes: string | null, rawSnippet?: string | null) {
  const explicitUnit = (unit ?? "").toLowerCase().trim();
  const combined = `${value} ${unit ?? ""} ${notes ?? ""} ${rawSnippet ?? ""}`.toLowerCase();

  if (
    /\bmt\/day\b|\bmt per day\b|\btons?\/day\b|\btonnes?\/day\b|\btpd\b|\bper day\b/.test(explicitUnit) ||
    /\bmt\/day\b|\bmt per day\b|\btons?\/day\b|\btonnes?\/day\b|\btpd\b/.test(combined)
  ) {
    return "day";
  }
  if (
    /\bmt\/shift\b|\bmt per shift\b|\btons?\/shift\b|\btonnes?\/shift\b|\bper shift\b/.test(explicitUnit) ||
    /\bmt\/shift\b|\bmt per shift\b|\btons?\/shift\b|\btonnes?\/shift\b/.test(combined)
  ) {
    return "shift";
  }
  if (
    /\bmt\/hour\b|\bmt\/hr\b|\bmt\/h\b|\bmt per hour\b|\btons?\/hour\b|\btonnes?\/hour\b|\bper hour\b/.test(explicitUnit) ||
    /\bmt\/hour\b|\bmt\/hr\b|\bmt\/h\b|\bmt per hour\b|\btons?\/hour\b|\btonnes?\/hour\b/.test(combined)
  ) {
    return "hour";
  }

  return null;
}

function detectGangMultiplier(value: string, notes: string | null, rawSnippet?: string | null) {
  const combined = `${value} ${notes ?? ""} ${rawSnippet ?? ""}`.toLowerCase();
  const explicitForMatch = combined.match(/\bfor\s+(\d+(?:\.\d+)?)\s+gangs?\b/);
  if (explicitForMatch) {
    const parsed = Number(explicitForMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const looseGangMatch = combined.match(/\b(\d+(?:\.\d+)?)\s+gangs?\b/);
  if (looseGangMatch && !/\bper gang\b/.test(combined)) {
    const parsed = Number(looseGangMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  return 1;
}

function detectShiftsPerDay(value: string, notes: string | null, rawSnippet?: string | null) {
  const combined = `${value} ${notes ?? ""} ${rawSnippet ?? ""}`.toLowerCase();
  const shiftMatch = combined.match(/\b(\d+(?:\.\d+)?)\s+shifts?(?:\s+per\s+day)?\b/);
  if (shiftMatch) {
    const parsed = Number(shiftMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 2;
}

function parseRateToDailyEquivalent(args: {
  value: string;
  unit: string | null;
  notes: string | null;
  rawSnippet?: string | null;
}) {
  const combined = `${args.value} ${args.unit ?? ""} ${args.notes ?? ""} ${args.rawSnippet ?? ""}`.toLowerCase();
  const rangeMatch = combined.match(
    /(-?\d[\d,]*(?:\.\d+)?)\s*(?:-|–|to)\s*(-?\d[\d,]*(?:\.\d+)?)/i
  );
  const singleMatch =
    combined.match(/\b(?:load(?:ing)? rate|discharg(?:e|ing) rate)?[^0-9]{0,20}(-?\d[\d,]*(?:\.\d+)?)/i) ||
    combined.match(/(-?\d[\d,]*(?:\.\d+)?)/);

  const values = rangeMatch
    ? [Number(String(rangeMatch[1]).replace(/,/g, "")), Number(String(rangeMatch[2]).replace(/,/g, ""))]
    : singleMatch
      ? [Number(String(singleMatch[1]).replace(/,/g, ""))]
      : [];
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) return null;

  const rateUnit = detectRateUnit(args.value, args.unit, args.notes, args.rawSnippet);
  if (!rateUnit) return null;

  const gangMultiplier = detectGangMultiplier(args.value, args.notes, args.rawSnippet);
  const shiftsPerDay = detectShiftsPerDay(args.value, args.notes, args.rawSnippet);
  const perGang = /\bper gang\b/.test(combined);

  const converted = values.map((numeric) => {
    let dailyEquivalent = numeric;
    if (rateUnit === "hour") dailyEquivalent = numeric * 24;
    else if (rateUnit === "shift") dailyEquivalent = numeric * shiftsPerDay;

    if (perGang || gangMultiplier > 1) {
      dailyEquivalent *= gangMultiplier;
    }
    return dailyEquivalent;
  });

  const minDailyEquivalent = Math.min(...converted);
  const maxDailyEquivalent = Math.max(...converted);

  return {
    dailyEquivalent: values.length === 1 ? converted[0] : (minDailyEquivalent + maxDailyEquivalent) / 2,
    minDailyEquivalent,
    maxDailyEquivalent,
    rateUnit,
    gangMultiplier,
    shiftsPerDay,
    perGang,
  };
}

function compareRateEquivalent(
  rate: { minDailyEquivalent: number; maxDailyEquivalent: number },
  comparator: "gt" | "gte" | "lt" | "lte",
  threshold: number
) {
  if (comparator === "gt") return rate.maxDailyEquivalent > threshold;
  if (comparator === "gte") return rate.maxDailyEquivalent >= threshold;
  if (comparator === "lt") return rate.minDailyEquivalent < threshold;
  return rate.minDailyEquivalent <= threshold;
}

function compareRateEquivalentRange(
  rate: { minDailyEquivalent: number; maxDailyEquivalent: number },
  minThreshold: number,
  maxThreshold: number
) {
  return rate.maxDailyEquivalent >= minThreshold && rate.minDailyEquivalent <= maxThreshold;
}

function formatLengthAnswerValue(args: {
  fact: FactForFilters;
  numericValue: number;
}) {
  const roundedMeters = Number(args.numericValue.toFixed(2));
  const raw = factRawDisplayValue(args.fact.value, args.fact.unit);
  const rawLower = raw.toLowerCase();
  const hasMetricAlready = /\b\d+(?:\.\d+)?\s*m\b|\b\d+(?:\.\d+)?\s*meters?\b|\b\d+(?:\.\d+)?\s*metres?\b/.test(
    rawLower
  );
  if (hasMetricAlready) return raw;
  return `${roundedMeters} m (${raw})`;
}

function formatRateAnswerValue(args: {
  fact: FactForFilters;
  numericValue: number;
}) {
  const roundedDaily = Math.round(args.numericValue);
  const raw = factRawDisplayValue(args.fact.value, args.fact.unit);
  return `${roundedDaily.toLocaleString("en-US")} MT/day eq (${raw})`;
}

function formatFactValueForDeterministicAnswer(args: {
  fact: FactForFilters;
  numericValue?: number;
  family: "length" | "plain" | "rate" | "density";
}) {
  if (args.family === "length" && typeof args.numericValue === "number") {
    return formatLengthAnswerValue({ fact: args.fact, numericValue: args.numericValue });
  }
  if (args.family === "rate" && typeof args.numericValue === "number") {
    return formatRateAnswerValue({ fact: args.fact, numericValue: args.numericValue });
  }
  return factRawDisplayValue(args.fact.value, args.fact.unit);
}

function evidenceBucketValueForFact(fact: {
  category: string;
  value: string;
  unit: string | null;
  notes: string | null;
  rawSnippet?: string | null;
}) {
  const derivedCategory = deriveFilterCategory({
    category: fact.category,
    value: fact.value,
    unit: fact.unit,
    notes: fact.notes,
    rawSnippet: fact.rawSnippet ?? null,
    scope: PortFactScope.PORT,
    terminal: null,
    berth: null,
    sourceRecord: null,
    createdAt: new Date(0),
  });

  if (derivedCategory === "load_rate" || derivedCategory === "discharge_rate") {
    const normalized = parseRateToDailyEquivalent({
      value: fact.value,
      unit: fact.unit,
      notes: fact.notes,
      rawSnippet: fact.rawSnippet,
    });
    if (normalized) {
      const roundedDaily = Math.round(normalized.dailyEquivalent);
      return `${roundedDaily.toLocaleString("en-US")} MT/day eq [from ${factRawDisplayValue(fact.value, fact.unit)}]`;
    }
  }

  return observationDisplayValue({
    category: fact.category,
    value: fact.value,
    unit: fact.unit,
    notes: fact.notes,
  });
}

function buildEvidenceFrequencyLines(args: {
  portName: string;
  facts: Array<{
    scope: PortFactScope;
    category: string;
    value: string;
    unit: string | null;
    notes: string | null;
    rawSnippet?: string | null;
    terminal: { name: string } | null;
    berth: { name: string } | null;
  }>;
}) {
  const grouped = new Map<
    string,
    {
      scope: PortFactScope;
      locationLabel: string;
      category: string;
      counts: Map<string, number>;
    }
  >();

  for (const fact of args.facts) {
    const location = scopeLabel(
      args.portName,
      fact.scope,
      fact.terminal?.name,
      fact.berth?.name
    );
    const category = fact.category.trim().toLowerCase();
    const key = `${fact.scope}__${location}__${category}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        scope: fact.scope,
        locationLabel: location,
        category,
        counts: new Map<string, number>(),
      });
    }

    const displayValue = evidenceBucketValueForFact({
      category,
      value: fact.value,
      unit: fact.unit,
      notes: fact.notes,
      rawSnippet: fact.rawSnippet ?? null,
    });
    const bucket = grouped.get(key)!;
    bucket.counts.set(displayValue, (bucket.counts.get(displayValue) ?? 0) + 1);
  }

  return Array.from(grouped.values())
    .filter((group) => group.counts.size > 0)
    .map((group) => {
      const counts = Array.from(group.counts.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 8)
        .map(([value, count]) => `${value} × ${count}`)
        .join("; ");

      return `  [EVIDENCE COUNTS ${group.scope}] ${group.locationLabel} | ${group.category}: ${counts}`;
    });
}

function factHaystack(fact: {
  category: string;
  value: string;
  unit: string | null;
  notes: string | null;
  rawSnippet?: string | null;
}) {
  return [fact.value, fact.unit, fact.notes, fact.rawSnippet].filter(Boolean).join(" ").toLowerCase();
}

function isDraftLikeFact(fact: {
  category: string;
  value: string;
  unit: string | null;
  notes: string | null;
  rawSnippet?: string | null;
}) {
  const category = fact.category.trim().toLowerCase();
  const haystack = factHaystack(fact);
  if (
    /\bdraft survey\b/.test(haystack) ||
    /\bshore scale\b/.test(haystack) ||
    /\bair draft\b/.test(haystack) ||
    /\bukc\b/.test(haystack) ||
    /under keel clearance/.test(haystack) ||
    /\bfreeboard\b/.test(haystack) ||
    /\bwlthc\b/.test(haystack) ||
    /\btopping\b/.test(haystack) ||
    /\bhatch\b/.test(haystack) ||
    /\bloa\b/.test(haystack) ||
    /\blength overall\b/.test(haystack) ||
    /\bbeam\b/.test(haystack) ||
    /\boutreach\b/.test(haystack) ||
    /\bdisplacement\b/.test(haystack)
  ) {
    return false;
  }

  if (category === "draft") return true;

  if (category !== "other" && category !== "restriction") return false;

  return (
    /\bmax draft\b/.test(haystack) ||
    /\bdraft alongside\b/.test(haystack) ||
    /\bdraft along side\b/.test(haystack) ||
    /\ballowable sail draft\b/.test(haystack) ||
    /\bchannel draft\b/.test(haystack) ||
    /\bseawater draft\b/.test(haystack) ||
    /\bfreshwater draft\b/.test(haystack) ||
    /\bmaximum draft\b/.test(haystack) ||
    /\bdepth at zero tide\b/.test(haystack)
  );
}

function deriveFilterCategory(fact: FactForFilters): NumericParameter | null {
  const base = fact.category.trim().toLowerCase();
  const haystack = factHaystack(fact);

  if (isDraftLikeFact(fact)) return "draft";
  if (/\bair draft\b/.test(haystack) || base === "air_draft") return "air_draft";
  if (/\bfreeboard\b/.test(haystack) || base === "freeboard") return "freeboard";
  if (/\bukc\b|under keel clearance/.test(haystack) || base === "ukc") return "ukc";
  if (/\bloa\b|\blength overall\b/.test(haystack) || base === "loa") return "loa";
  if (/\bbeam\b/.test(haystack) || base === "beam") return "beam";
  if (/\bdwt\b|\bdeadweight\b/.test(haystack) || base === "dwt") return "dwt";
  if (/\bdensity\b|\bspecific gravity\b|\bsalinity\b/.test(haystack) || base === "density") return "density";
  if (/\bload rate\b|\bloading rate\b/.test(haystack) || base === "load_rate") return "load_rate";
  if (/\bdischarge rate\b|\bdischarging rate\b/.test(haystack) || base === "discharge_rate") return "discharge_rate";
  if (/\bgangs?\b/.test(haystack) || base === "gangs") return "gangs";
  if (/\bshifts?\b/.test(haystack) || base === "shifts") return "shifts";
  if (/\btrim\b/.test(haystack) || base === "trim") return "trim";
  if (/\btide\b|\bmllw\b|\bmlws\b|\bhigh water\b|\blow water\b/.test(haystack) || base === "tide") return "tide";
  return null;
}

function parseNumericMeters(args: {
  value: string;
  unit: string | null;
  notes: string | null;
  rawSnippet?: string | null;
}, family: "length" | "plain" | "rate" | "density" = "length") {
  if (family === "rate") {
    const normalizedRate = parseRateToDailyEquivalent(args);
    if (normalizedRate) return normalizedRate.dailyEquivalent;
  }

  const valueText = `${args.value}`.trim();
  const explicitUnit = (args.unit ?? "").toLowerCase();
  const combined = `${args.value} ${args.unit ?? ""} ${args.notes ?? ""} ${args.rawSnippet ?? ""}`.toLowerCase();

  if (/^-?\d+(?:\.\d+)?$/.test(valueText)) {
    const numeric = Number(valueText);
    if (!Number.isFinite(numeric)) return null;
    if (family === "length" && /\bft\b|\bfeet\b|\bfoot\b/.test(explicitUnit)) return numeric * 0.3048;
    return numeric;
  }

  const patterns = [
    /\bdraft(?:\s+alongside|\s+along\s+side|\s+limit|\s+at berth|\s+at)?[^0-9]{0,20}(-?\d+(?:\.\d+)?)\s*(m|meter|meters|metres|ft|feet|foot)?/i,
    /\ballowable sail draft[^0-9]{0,20}(-?\d+(?:\.\d+)?)\s*(m|meter|meters|metres|ft|feet|foot)?/i,
    /\bchannel draft[^0-9]{0,20}(-?\d+(?:\.\d+)?)\s*(m|meter|meters|metres|ft|feet|foot)?/i,
    /\bloa[^0-9]{0,20}(-?\d+(?:\.\d+)?)\s*(m|meter|meters|metres|ft|feet|foot)?/i,
    /\blength overall[^0-9]{0,20}(-?\d+(?:\.\d+)?)\s*(m|meter|meters|metres|ft|feet|foot)?/i,
    /\bbeam[^0-9]{0,20}(-?\d+(?:\.\d+)?)\s*(m|meter|meters|metres|ft|feet|foot)?/i,
    /\bair draft[^0-9]{0,20}(-?\d+(?:\.\d+)?)\s*(m|meter|meters|metres|ft|feet|foot)?/i,
    /\bukc[^0-9]{0,20}(-?\d+(?:\.\d+)?)\s*(m|meter|meters|metres|ft|feet|foot)?/i,
    /\bfreeboard[^0-9]{0,20}(-?\d+(?:\.\d+)?)\s*(m|meter|meters|metres|ft|feet|foot)?/i,
    /\btrim[^0-9]{0,20}(-?\d+(?:\.\d+)?)\s*(m|meter|meters|metres|ft|feet|foot)?/i,
    /\bdensity[^0-9]{0,20}(-?\d+(?:\.\d+)?)/i,
    /\bspecific gravity[^0-9]{0,20}(-?\d+(?:\.\d+)?)/i,
    /\bdwt[^0-9]{0,20}(-?\d+(?:\.\d+)?)/i,
    /\bdeadweight[^0-9]{0,20}(-?\d+(?:\.\d+)?)/i,
    /\bload(?:ing)? rate[^0-9]{0,20}(-?\d[\d,]*(?:\.\d+)?)/i,
    /\bdischarg(?:e|ing) rate[^0-9]{0,20}(-?\d[\d,]*(?:\.\d+)?)/i,
    /\bgangs?\b[^0-9]{0,20}(-?\d+(?:\.\d+)?)/i,
    /\bshifts?\b[^0-9]{0,20}(-?\d+(?:\.\d+)?)/i,
    /(-?\d+(?:\.\d+)?)\s*(m|meter|meters|metres|ft|feet|foot)\s*(?:fw|sw|bw)?\b/i,
    /(-?\d[\d,]*(?:\.\d+)?)/i,
  ];

  for (const pattern of patterns) {
    const match = combined.match(pattern);
    if (!match) continue;
    const numeric = Number(String(match[1]).replace(/,/g, ""));
    if (!Number.isFinite(numeric)) continue;
    const unit = (match[2] ?? explicitUnit ?? "m").toLowerCase();
    return family === "length" && /\bft\b|\bfeet\b|\bfoot\b/.test(unit) ? numeric * 0.3048 : numeric;
  }

  return null;
}

function parseComparator(value: string): "gt" | "gte" | "lt" | "lte" {
  const normalized = value.toLowerCase();
  if (/>=|at least|not less than|не меньше/.test(normalized)) return "gte";
  if (/<=|at most|not more than|не больше/.test(normalized)) return "lte";
  if (/under|below|less than|shallower than|shallow|меньше|ниже/.test(normalized)) return "lt";
  return "gt";
}

function compareNumeric(actual: number, comparator: "gt" | "gte" | "lt" | "lte", threshold: number) {
  if (comparator === "gt") return actual > threshold;
  if (comparator === "gte") return actual >= threshold;
  if (comparator === "lt") return actual < threshold;
  return actual <= threshold;
}

function isSummaryOverviewRequest(question: string) {
  const normalized = question.toLowerCase();
  return (
    normalized.includes("summary overview for") ||
    normalized.includes("use this exact evidence-first structure") ||
    normalized.includes("latest 5 mentions for that category")
  );
}

function extractRawUserQuestion(question: string) {
  const trimmed = question.trim();
  const patterns = [
    /^use the whole database for this question\.[\s\S]*?\n\n/i,
    /^focus only on [\s\S]*?\n\n/i,
  ];

  for (const pattern of patterns) {
    if (pattern.test(trimmed)) {
      return trimmed.replace(pattern, "").trim();
    }
  }

  return trimmed;
}

function canonicalCountry(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function questionMatchesCountry(question: string, country: string) {
  const canonical = canonicalCountry(country);
  if (!canonical) return false;

  const aliases = new Set<string>([canonical]);
  if (canonical === "us" || canonical === "usa" || canonical === "united states") {
    aliases.add("us");
    aliases.add("usa");
    aliases.add("u.s.");
    aliases.add("united states");
    aliases.add("united states of america");
    aliases.add("american");
  }
  if (canonical === "canada") {
    aliases.add("canada");
    aliases.add("canadian");
  }
  if (canonical === "china") {
    aliases.add("china");
    aliases.add("chinese");
  }
  if (canonical === "australia") {
    aliases.add("australia");
    aliases.add("australian");
  }

  return Array.from(aliases).some((alias) => {
    const escaped = escapeRegExp(alias);
    return new RegExp(`(?:^|[^a-z])${escaped}(?:$|[^a-z])`, "i").test(question);
  });
}

function detectPortContext(question: string, ports: PortForFilters[]) {
  const lower = question.toLowerCase();
  const matches = ports
    .map((port) => port.name)
    .filter((name) => lower.includes(name.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  return matches[0];
}

function detectTerminalContext(question: string, ports: PortForFilters[]) {
  const lower = question.toLowerCase();
  const terminalNames = Array.from(
    new Set(
      ports.flatMap((port) =>
        port.facts.map((fact) => fact.terminal?.name).filter((name): name is string => Boolean(name))
      )
    )
  );
  const matches = terminalNames
    .filter((name) => lower.includes(name.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  return matches[0];
}

function detectBerthContext(question: string, ports: PortForFilters[]) {
  const lower = question.toLowerCase();
  const berthNames = Array.from(
    new Set(
      ports.flatMap((port) =>
        port.facts.map((fact) => fact.berth?.name).filter((name): name is string => Boolean(name))
      )
    )
  );
  const matches = berthNames
    .filter((name) => lower.includes(name.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  return matches[0];
}

function parseSummaryContext(
  latestUserMessage: string,
  routingQuestion: string,
  ports: PortForFilters[]
): ParsedSummaryContext | null {
  if (!isSummaryOverviewRequest(routingQuestion)) return null;

  const raw = latestUserMessage;
  const berthInsideTerminalMatch = raw.match(
    /Focus only on berth "([^"]+)" inside terminal "([^"]+)" in port "([^"]+)"/i
  );
  if (berthInsideTerminalMatch) {
    return {
      scope: "berth",
      berthContextName: berthInsideTerminalMatch[1],
      terminalContextName: berthInsideTerminalMatch[2],
      portContextName: berthInsideTerminalMatch[3],
    };
  }

  const berthMatch = raw.match(/Focus only on berth "([^"]+)" in port "([^"]+)"/i);
  if (berthMatch) {
    return {
      scope: "berth",
      berthContextName: berthMatch[1],
      portContextName: berthMatch[2],
    };
  }

  const terminalMatch = raw.match(/Focus only on terminal "([^"]+)" in port "([^"]+)"/i);
  if (terminalMatch) {
    return {
      scope: "terminal",
      terminalContextName: terminalMatch[1],
      portContextName: terminalMatch[2],
    };
  }

  const portMatch = raw.match(/Focus only on port "([^"]+)"/i);
  if (portMatch) {
    return {
      scope: "port",
      portContextName: portMatch[1],
    };
  }

  const berthContextName = detectBerthContext(latestUserMessage, ports) ?? detectBerthContext(routingQuestion, ports);
  const terminalContextName =
    detectTerminalContext(latestUserMessage, ports) ?? detectTerminalContext(routingQuestion, ports);
  const portContextName = detectPortContext(latestUserMessage, ports) ?? detectPortContext(routingQuestion, ports);

  if (berthContextName) {
    return {
      scope: "berth",
      berthContextName,
      terminalContextName: terminalContextName ?? undefined,
      portContextName: portContextName ?? undefined,
    };
  }

  if (terminalContextName) {
    return {
      scope: "terminal",
      terminalContextName,
      portContextName: portContextName ?? undefined,
    };
  }

  if (portContextName) {
    return {
      scope: "port",
      portContextName,
    };
  }

  return null;
}

function shouldTrySemanticPlanner(question: string) {
  if (isSummaryOverviewRequest(question)) return false;
  return /\bports?\b|\bterminals?\b|\bberths?\b|порты|терминал|причал|which|what|show me|find/i.test(
    question
  );
}

function buildPlannerContext(ports: PortForFilters[]) {
  return ports
    .map((port) => {
      const terminalNames = Array.from(
        new Set(
          port.facts
            .map((fact) => fact.terminal?.name)
            .filter((name): name is string => Boolean(name))
        )
      )
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 12);
      return `- ${port.name}${port.country ? `, ${port.country}` : ""}${
        terminalNames.length ? ` | terminals: ${terminalNames.join("; ")}` : ""
      }`;
    })
    .join("\n");
}

function normalizePlannerUnit(unit: string | undefined, family: "length" | "plain" | "rate" | "density") {
  if (!unit) return family === "length" ? "m" : "";
  return unit;
}

function plannerFilterToDeterministic(
  filter: SemanticPlannerFilter,
  ports: PortForFilters[]
): DeterministicFilter | null {
  if (filter.type === "numeric") {
    const config = NUMERIC_PARAMETER_CONFIG.find((item) => item.parameter === filter.category);
    if (!config) return null;
    if (filter.operator === "between") {
      if (typeof filter.min !== "number" || typeof filter.max !== "number") return null;
      const min = filter.min;
      const max = filter.max;
      return {
        kind: "numeric_range",
        parameter: filter.category,
        minThreshold: Math.min(min, max),
        maxThreshold: Math.max(min, max),
        displayRange: `${Math.min(min, max)} ${normalizePlannerUnit(filter.unit, config.family)} to ${Math.max(min, max)} ${normalizePlannerUnit(filter.unit, config.family)}`.trim(),
      };
    }
    if (typeof filter.value !== "number") return null;
    return {
      kind: "numeric",
      parameter: filter.category,
      comparator: filter.operator,
      threshold: filter.value,
      displayThreshold: `${filter.value}${filter.unit ? ` ${filter.unit}` : config.family === "length" ? " m" : ""}`.trim(),
    };
  }

  if (filter.type === "capability") {
    const match = CAPABILITY_FILTERS.find(
      (item) => item.capability.toLowerCase() === filter.capability.toLowerCase()
    );
    if (!match) return null;
    return {
      kind: "capability",
      capability: match.capability,
      displayLabel: match.displayLabel,
    };
  }

  if (filter.type === "condition") {
    const match = CONDITION_FILTERS.find(
      (item) => item.token.toLowerCase() === filter.condition.toLowerCase()
    );
    if (!match) return null;
    return {
      kind: "condition",
      token: match.token,
      displayLabel: match.displayLabel,
    };
  }

  if (filter.type === "country") {
    const matchedCountry = ports
      .map((port) => port.country)
      .filter((country): country is string => Boolean(country))
      .find((country) => canonicalCountry(country) === canonicalCountry(filter.country));
    if (!matchedCountry) return null;
    return {
      kind: "country",
      country: matchedCountry,
      displayLabel: matchedCountry,
    };
  }

  return null;
}

async function planSemanticFilterQuery(
  question: string,
  ports: PortForFilters[]
): Promise<DeterministicQuery | null> {
  if (!shouldTrySemanticPlanner(question)) return null;

  const plannerPrompt = `
You convert a user's natural-language search question into a strict filter plan for a port intelligence database.

Rules:
- Only return intent="filter" when the user is clearly asking to find ports, terminals, or berths matching criteria.
- Prefer semantic understanding over literal keyword matching.
- Use only supported categories:
  draft, loa, beam, air_draft, dwt, density, load_rate, discharge_rate, gangs, shifts, ukc, freeboard, trim, tide
- Use only supported capabilities:
  grain, cement, coal, petcoke, sulphur
- Use only supported conditions:
  FW, SW, Brackish, NAABSA, Zero tide, HW, LW
- If the user names a known port or terminal, put it in locationContext.
- If the user asks about terminals in a port, scope=terminal.
- If the user asks about berths in a port or terminal, scope=berth.
- Use combineMode="or" only when the user explicitly asks an OR-style query. Otherwise use "and".
- If you are not confident that this is a filter/search query, return intent="other" with filters=[].
`.trim();

  const plannerContext = buildPlannerContext(ports);
  const response = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "semantic_filter_plan",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            intent: { type: "string", enum: ["filter", "other"] },
            scope: { type: "string", enum: ["port", "terminal", "berth"] },
            combineMode: { type: "string", enum: ["and", "or"] },
            locationContext: {
              type: "object",
              additionalProperties: false,
              properties: {
                port: { type: "string" },
                terminal: { type: "string" },
              },
              required: [],
            },
            filters: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { type: "string", enum: ["numeric", "capability", "condition", "country"] },
                  category: { type: "string" },
                  operator: { type: "string", enum: ["gt", "gte", "lt", "lte", "between"] },
                  value: { type: "number" },
                  min: { type: "number" },
                  max: { type: "number" },
                  unit: { type: "string" },
                  capability: { type: "string" },
                  mode: { type: "string", enum: ["include", "exclude"] },
                  condition: { type: "string" },
                  country: { type: "string" },
                },
                required: ["type"],
              },
            },
          },
          required: ["intent", "scope", "combineMode", "filters"],
        },
      },
    },
    messages: [
      { role: "system", content: plannerPrompt },
      { role: "system", content: `Known ports and terminals:\n${plannerContext}` },
      { role: "user", content: question },
    ],
  });

  const rawContent = response.choices[0]?.message?.content;
  if (!rawContent) return null;

  const parsed = JSON.parse(rawContent) as SemanticPlannerResult;
  if (parsed.intent !== "filter" || !Array.isArray(parsed.filters) || parsed.filters.length === 0) {
    return null;
  }

  const filters: DeterministicFilter[] = [];
  const negateCapabilities: string[] = [];
  const negateConditions: string[] = [];

  for (const filter of parsed.filters) {
    if (filter.type === "capability" && filter.mode === "exclude") {
      negateCapabilities.push(filter.capability);
      continue;
    }
    if (filter.type === "condition" && filter.mode === "exclude") {
      negateConditions.push(filter.condition);
      continue;
    }
    const mapped = plannerFilterToDeterministic(filter, ports);
    if (mapped) filters.push(mapped);
  }

  const matchedPortContext = parsed.locationContext?.port
    ? detectPortContext(parsed.locationContext.port, ports)
    : undefined;
  const matchedTerminalContext = parsed.locationContext?.terminal
    ? detectTerminalContext(parsed.locationContext.terminal, ports)
    : undefined;

  return {
    filters,
    mode: parsed.combineMode === "or" ? "or" : "and",
    scope: parsed.scope,
    portContextName: matchedPortContext,
    terminalContextName: matchedTerminalContext,
    negateCapabilities,
    negateConditions,
  };
}

function parseDeterministicQuery(question: string, ports: PortForFilters[]): DeterministicQuery {
  const lower = question.toLowerCase();
  if (isSummaryOverviewRequest(question)) {
    return {
      filters: [],
      mode: "and",
      scope: "port",
      negateCapabilities: [],
      negateConditions: [],
    };
  }
  const filters: DeterministicFilter[] = [];
  const negateCapabilities: string[] = [];
  const negateConditions: string[] = [];
  const mode: "and" | "or" = /\bor\b| либо | или /i.test(question) ? "or" : "and";
  const scope: "port" | "terminal" | "berth" =
    /\bberths?\b|причал/i.test(question)
      ? "berth"
      : /\bterminals?\b|терминал/i.test(question)
        ? "terminal"
        : "port";
  const portContextName = detectPortContext(question, ports);
  const terminalContextName = detectTerminalContext(question, ports);

  for (const config of NUMERIC_PARAMETER_CONFIG) {
    for (const alias of config.aliases) {
      const betweenPatterns = [
        new RegExp(`\\b${alias.replace(/\s+/g, "\\s+")}\\b[\\s\\S]{0,40}?(between)\\s+(\\d[\\d,]*(?:\\.\\d+)?)\\s*(m|meter|meters|metres|ft|feet|foot)?\\s+(?:and|to)\\s+(\\d[\\d,]*(?:\\.\\d+)?)\\s*(m|meter|meters|metres|ft|feet|foot)?`, "i"),
        new RegExp(`between\\s+(\\d[\\d,]*(?:\\.\\d+)?)\\s*(m|meter|meters|metres|ft|feet|foot)?\\s+(?:and|to)\\s+(\\d[\\d,]*(?:\\.\\d+)?)\\s*(m|meter|meters|metres|ft|feet|foot)?[\\s\\S]{0,20}?\\b${alias.replace(/\s+/g, "\\s+")}\\b`, "i"),
      ];

      for (const pattern of betweenPatterns) {
        const match = lower.match(pattern);
        if (!match) continue;
        const firstValue = Number(String(match[pattern === betweenPatterns[0] ? 2 : 1]).replace(/,/g, ""));
        const firstUnit = match[pattern === betweenPatterns[0] ? 3 : 2] ?? (config.family === "length" ? "m" : "");
        const secondValue = Number(String(match[pattern === betweenPatterns[0] ? 4 : 3]).replace(/,/g, ""));
        const secondUnit = match[pattern === betweenPatterns[0] ? 5 : 4] ?? firstUnit;
        if (!Number.isFinite(firstValue) || !Number.isFinite(secondValue)) continue;
        const lowerBound =
          config.family === "length" && /\bft\b|\bfeet\b|\bfoot\b/i.test(firstUnit)
            ? firstValue * 0.3048
            : firstValue;
        const upperBound =
          config.family === "length" && /\bft\b|\bfeet\b|\bfoot\b/i.test(secondUnit)
            ? secondValue * 0.3048
            : secondValue;
        const low = Math.min(lowerBound, upperBound);
        const high = Math.max(lowerBound, upperBound);
        filters.push({
          kind: "numeric_range",
          parameter: config.parameter,
          minThreshold: low,
          maxThreshold: high,
          displayRange:
            `${Math.min(firstValue, secondValue)}${firstUnit ? ` ${firstUnit}` : ""} to ${Math.max(firstValue, secondValue)}${secondUnit ? ` ${secondUnit}` : ""}`.trim(),
        });
        break;
      }

      const patterns = [
        new RegExp(`\\b${alias.replace(/\s+/g, "\\s+")}\\b[\\s\\S]{0,40}?(above|over|greater than|more than|deeper than|>=|>|at least|under|below|less than|shallower than|<=|<|at most)\\s+(\\d[\\d,]*(?:\\.\\d+)?)\\s*(m|meter|meters|metres|ft|feet|foot)?`, "i"),
        new RegExp(`(above|over|greater than|more than|deeper than|>=|>|at least|under|below|less than|shallower than|<=|<|at most)\\s+(\\d[\\d,]*(?:\\.\\d+)?)\\s*(m|meter|meters|metres|ft|feet|foot)?[\\s\\S]{0,20}?\\b${alias.replace(/\s+/g, "\\s+")}\\b`, "i"),
      ];

      for (const pattern of patterns) {
        const match = lower.match(pattern);
        if (!match) continue;
        const comparator = parseComparator(match[1]);
        const numeric = Number(String(match[2]).replace(/,/g, ""));
        if (!Number.isFinite(numeric)) continue;
        const unit = match[3] ?? (config.family === "length" ? "m" : "");
        const threshold =
          config.family === "length" && /\bft\b|\bfeet\b|\bfoot\b/i.test(unit)
            ? numeric * 0.3048
            : numeric;
        filters.push({
          kind: "numeric",
          parameter: config.parameter,
          comparator,
          threshold,
          displayThreshold: `${numeric}${unit ? ` ${unit}` : ""}`.trim(),
        });
        break;
      }
    }
  }

  for (const config of CAPABILITY_FILTERS) {
    if (config.aliases.some((alias) => new RegExp(`\\bnot\\s+${alias}\\b|without\\s+${alias}\\b|не\\s+${alias}`).test(lower))) {
      negateCapabilities.push(config.capability);
      continue;
    }
    if (config.aliases.some((alias) => lower.includes(alias))) {
      filters.push({
        kind: "capability",
        capability: config.capability,
        displayLabel: config.displayLabel,
      });
    }
  }

  for (const config of CONDITION_FILTERS) {
    if (config.aliases.some((alias) => new RegExp(`\\bnot\\s+${alias}\\b|without\\s+${alias}\\b|не\\s+${alias}`).test(lower))) {
      negateConditions.push(config.token);
      continue;
    }
    if (config.aliases.some((alias) => lower.includes(alias))) {
      filters.push({
        kind: "condition",
        token: config.token,
        displayLabel: config.displayLabel,
      });
    }
  }

  const countriesInQuestion = Array.from(
    new Set(
      ports
        .map((port) => port.country)
        .filter((country): country is string => Boolean(country))
        .filter((country) => questionMatchesCountry(question, country))
    )
  );

  for (const country of countriesInQuestion) {
    filters.push({
      kind: "country",
      country,
      displayLabel: country,
    });
  }

  const seen = new Set<string>();
  const deduped = filters.filter((filter) => {
    const key =
      filter.kind === "numeric"
        ? `${filter.kind}:${filter.parameter}:${filter.comparator}:${filter.threshold}`
        : filter.kind === "numeric_range"
          ? `${filter.kind}:${filter.parameter}:${filter.minThreshold}:${filter.maxThreshold}`
        : filter.kind === "capability"
          ? `${filter.kind}:${filter.capability}`
          : filter.kind === "condition"
            ? `${filter.kind}:${filter.token}`
            : `${filter.kind}:${filter.country}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    filters: deduped,
    mode,
    scope,
    portContextName,
    terminalContextName,
    negateCapabilities,
    negateConditions,
  };
}

function formatComparator(filter: NumericFilter) {
  if (filter.comparator === "gt") return `over ${filter.displayThreshold}`;
  if (filter.comparator === "gte") return `at least ${filter.displayThreshold}`;
  if (filter.comparator === "lt") return `under ${filter.displayThreshold}`;
  return `at most ${filter.displayThreshold}`;
}

function formatRange(filter: NumericRangeFilter) {
  return `between ${filter.displayRange}`;
}

function describeDeterministicFilter(filter: DeterministicFilter) {
  if (filter.kind === "numeric") {
    return `${NUMERIC_PARAMETER_CONFIG.find((item) => item.parameter === filter.parameter)?.label ?? filter.parameter} ${formatComparator(filter)}`;
  }
  if (filter.kind === "numeric_range") {
    return `${NUMERIC_PARAMETER_CONFIG.find((item) => item.parameter === filter.parameter)?.label ?? filter.parameter} ${formatRange(filter)}`;
  }
  if (filter.kind === "capability") return filter.displayLabel;
  if (filter.kind === "country") return `Country ${filter.displayLabel}`;
  return `Condition ${filter.displayLabel}`;
}

function locationLabelForScope(
  portName: string,
  fact: FactForFilters,
  scope: "port" | "terminal" | "berth"
) {
  if (scope === "berth") {
    return [fact.terminal?.name, fact.berth?.name].filter(Boolean).join(" > ");
  }
  if (scope === "terminal") {
    return fact.terminal?.name ?? "";
  }
  return fact.scope === PortFactScope.BERTH
    ? [fact.terminal?.name, fact.berth?.name].filter(Boolean).join(" > ")
    : fact.scope === PortFactScope.TERMINAL
      ? fact.terminal?.name ?? portName
      : portName;
}

function isBerthLikeLocationName(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return false;
  return (
    /\bberth\b|\bpier\b|\bjetty\b|\bdock\b|\bwharf\b|\bquay\b/.test(normalized) ||
    /\b(lb|b|pbg)\s*-?\d+\b/.test(normalized) ||
    /\b\d+#\b/.test(normalized) ||
    /^\d+[a-z]?$/i.test(normalized)
  );
}

function factMatchesRequestedScope(
  fact: FactForFilters,
  scope: "port" | "terminal" | "berth"
) {
  if (scope === "port") return true;
  if (scope === "terminal") return Boolean(fact.terminal?.name);
  return Boolean(fact.berth?.name) || isBerthLikeLocationName(fact.terminal?.name);
}

function matchedLocationForScope(
  portName: string,
  portCountry: string | null | undefined,
  fact: FactForFilters,
  scope: "port" | "terminal" | "berth"
): MatchedLocation {
  if (scope === "berth") {
    return {
      portName,
      portCountry: portCountry ?? undefined,
      terminalName: fact.terminal?.name ?? undefined,
      berthName: fact.berth?.name ?? undefined,
    };
  }
  if (scope === "terminal") {
    return {
      portName,
      portCountry: portCountry ?? undefined,
      terminalName: fact.terminal?.name ?? undefined,
    };
  }
  return {
    portName,
    portCountry: portCountry ?? undefined,
    terminalName: fact.terminal?.name ?? undefined,
    berthName: fact.berth?.name ?? undefined,
  };
}

function buildDeterministicFilterAnswer(args: {
  ports: PortForFilters[];
  query: DeterministicQuery;
}) {
  const matchedLocations: MatchedLocation[] = [];
  const resultRows: ResultRow[] = [];
  const matches = args.ports
    .filter((port) =>
      args.query.portContextName
        ? port.name.toLowerCase() === args.query.portContextName.toLowerCase()
        : true
    )
    .map((port) => {
      const inferredCapabilities = inferCapabilities({
        portName: port.name,
        facts: port.facts,
      });

      const filterSections: string[] = [];
      const matchedPositiveFilters = new Set<string>();

      if (
        args.query.negateCapabilities.some((token) =>
          inferredCapabilities.some((capability) => capability.capability.toLowerCase().includes(token))
        )
      ) {
        return null;
      }

      if (
        args.query.negateConditions.some((token) =>
          port.facts.some((fact) =>
            conditionTagsFromParsed(
              parseOperationalConditions(
                fact.value,
                fact.unit,
                [fact.notes, fact.rawSnippet].filter(Boolean).join(" ")
              )
            ).includes(token)
          )
        )
      ) {
        return null;
      }

      for (const filter of args.query.filters) {
        if (filter.kind === "numeric" || filter.kind === "numeric_range") {
          const config = NUMERIC_PARAMETER_CONFIG.find((item) => item.parameter === filter.parameter)!;
          const qualifyingFacts = port.facts
            .filter((fact) =>
              args.query.terminalContextName
                ? (fact.terminal?.name ?? "").toLowerCase() === args.query.terminalContextName.toLowerCase()
                : true
            )
            .filter((fact) => factMatchesRequestedScope(fact, args.query.scope))
            .filter((fact) => deriveFilterCategory(fact) === filter.parameter)
            .map((fact) => {
              const normalizedRate =
                config.family === "rate"
                  ? parseRateToDailyEquivalent({
                      value: fact.value,
                      unit: fact.unit,
                      notes: fact.notes,
                      rawSnippet: fact.rawSnippet ?? null,
                    })
                  : null;
              const numericValue = parseNumericMeters(
                {
                  value: fact.value,
                  unit: fact.unit,
                  notes: fact.notes,
                  rawSnippet: fact.rawSnippet ?? null,
                },
                config.family
              );
              return numericValue == null
                ? null
                : {
                    fact,
                    numericValue,
                    normalizedRate,
                  };
            })
            .filter((item): item is { fact: FactForFilters; numericValue: number; normalizedRate: ReturnType<typeof parseRateToDailyEquivalent> | null } => {
              if (!item) return false;
              if (config.family === "rate" && item.normalizedRate) {
                if (filter.kind === "numeric_range") {
                  return compareRateEquivalentRange(
                    item.normalizedRate,
                    filter.minThreshold,
                    filter.maxThreshold
                  );
                }
                return compareRateEquivalent(
                  item.normalizedRate,
                  filter.comparator,
                  filter.threshold
                );
              }
              if (filter.kind === "numeric_range") {
                return item.numericValue >= filter.minThreshold && item.numericValue <= filter.maxThreshold;
              }
              return compareNumeric(item.numericValue, filter.comparator, filter.threshold);
            })
            .sort((a, b) => {
              const aTime = a.fact.sourceRecord?.sourceDate?.getTime() ?? a.fact.createdAt.getTime();
              const bTime = b.fact.sourceRecord?.sourceDate?.getTime() ?? b.fact.createdAt.getTime();
              return b.numericValue - a.numericValue || bTime - aTime;
            });

          if (qualifyingFacts.length === 0) {
            if (args.query.mode === "and") return null;
            continue;
          }

          const byLocation = new Map<
            string,
            {
              locationLabel: string;
              bestValue: number;
              line: string;
            }
          >();

          for (const item of qualifyingFacts) {
            const location = locationLabelForScope(port.name, item.fact, args.query.scope);
            if (!location) continue;
            const locationKey = location.toLowerCase();
            const date = fmtDate(item.fact.sourceRecord?.sourceDate ?? item.fact.createdAt);
            const conditionText = item.fact.notes ? ` (${item.fact.notes})` : "";
            const formattedValue = formatFactValueForDeterministicAnswer({
              fact: item.fact,
              numericValue: item.numericValue,
              family: config.family,
            });
            const line = `    - ${location} — ${formattedValue}${conditionText} (${date})`;

            const existing = byLocation.get(locationKey);
            if (!existing || item.numericValue > existing.bestValue) {
              byLocation.set(locationKey, {
                locationLabel: location,
                bestValue: item.numericValue,
                line,
              });
            }
          }

          const lines = Array.from(byLocation.values())
            .sort((a, b) => b.bestValue - a.bestValue || a.locationLabel.localeCompare(b.locationLabel))
            .map((item) => item.line);
          const filterDescription =
            filter.kind === "numeric_range" ? formatRange(filter) : formatComparator(filter);

          for (const item of qualifyingFacts) {
            matchedLocations.push(matchedLocationForScope(port.name, port.country, item.fact, args.query.scope));
            resultRows.push({
              portName: port.name,
              terminalName:
                args.query.scope === "port" ? item.fact.terminal?.name ?? undefined : item.fact.terminal?.name ?? undefined,
              berthName: args.query.scope === "berth" ? item.fact.berth?.name ?? undefined : undefined,
              matchLabel: `${config.label} ${filterDescription}`,
              matchValue: `${formatFactValueForDeterministicAnswer({
                fact: item.fact,
                numericValue: item.numericValue,
                family: config.family,
              })}${item.fact.notes ? ` (${item.fact.notes})` : ""}`,
              date: fmtDate(item.fact.sourceRecord?.sourceDate ?? item.fact.createdAt),
            });
          }

          filterSections.push(`  - ${config.label} ${filterDescription}:\n${lines.join("\n")}`);
          matchedPositiveFilters.add(
            filter.kind === "numeric_range"
              ? `${filter.kind}:${filter.parameter}:${filter.minThreshold}:${filter.maxThreshold}`
              : `${filter.kind}:${filter.parameter}:${filter.comparator}:${filter.threshold}`
          );
          continue;
        }

        if (filter.kind === "capability") {
          const matchingCapabilities = inferredCapabilities
            .filter((capability) =>
              args.query.terminalContextName
                ? (capability.locationLabel.split(" > ")[1] ?? "").toLowerCase() ===
                  args.query.terminalContextName.toLowerCase()
                : true
            )
            .filter((capability) => capability.capability.toLowerCase().includes(filter.capability))
            .map((capability) => `    - ${capability.locationLabel} (${capability.reason})`);

          if (matchingCapabilities.length === 0) {
            if (args.query.mode === "and") return null;
            continue;
          }
          for (const capability of inferredCapabilities.filter((item) =>
            item.capability.toLowerCase().includes(filter.capability)
          )) {
            const parts = capability.locationLabel.split(" > ");
            matchedLocations.push({
              portName: port.name,
              portCountry: port.country ?? undefined,
              terminalName: args.query.scope === "port" ? parts[1] || undefined : parts[1] || undefined,
              berthName: args.query.scope === "berth" ? parts[2] || undefined : undefined,
            });
            resultRows.push({
              portName: port.name,
              terminalName: parts[1] || undefined,
              berthName: args.query.scope === "berth" ? parts[2] || undefined : undefined,
              matchLabel: filter.displayLabel,
              matchValue: capability.reason,
              date: "Inferred",
            });
          }
          filterSections.push(`  - ${filter.displayLabel}:\n${matchingCapabilities.join("\n")}`);
          matchedPositiveFilters.add(`${filter.kind}:${filter.capability}`);
          continue;
        }

        if (filter.kind === "country") {
          const matchesCountry = canonicalCountry(port.country) === canonicalCountry(filter.country);
          if (!matchesCountry) {
            if (args.query.mode === "and") return null;
            continue;
          }
          filterSections.push(`  - Country: ${filter.displayLabel}`);
          matchedPositiveFilters.add(`${filter.kind}:${filter.country}`);
          continue;
        }

        const matchingConditionFacts = port.facts
          .filter((fact) =>
            args.query.terminalContextName
              ? (fact.terminal?.name ?? "").toLowerCase() === args.query.terminalContextName.toLowerCase()
              : true
          )
          .filter((fact) => factMatchesRequestedScope(fact, args.query.scope))
          .map((fact) => {
            const tags = conditionTagsFromParsed(
              parseOperationalConditions(
                fact.value,
                fact.unit,
                [fact.notes, fact.rawSnippet].filter(Boolean).join(" ")
              )
            );
            return {
              fact,
              tags,
            };
          })
          .filter((item) => item.tags.includes(filter.token));

        if (matchingConditionFacts.length === 0) {
          if (args.query.mode === "and") return null;
          continue;
        }

        const lines = matchingConditionFacts.slice(0, 6).map((item) => {
          const location = locationLabelForScope(port.name, item.fact, args.query.scope);
          const date = fmtDate(item.fact.sourceRecord?.sourceDate ?? item.fact.createdAt);
          return `    - ${location || port.name} | ${item.fact.category}: ${item.fact.value}${item.fact.unit ? ` ${item.fact.unit}` : ""} (${date})`;
        });

        for (const item of matchingConditionFacts) {
          matchedLocations.push(matchedLocationForScope(port.name, port.country, item.fact, args.query.scope));
          resultRows.push({
            portName: port.name,
            terminalName: item.fact.terminal?.name ?? undefined,
            berthName: args.query.scope === "berth" ? item.fact.berth?.name ?? undefined : undefined,
            matchLabel: `Condition ${filter.displayLabel}`,
            matchValue: `${item.fact.category}: ${item.fact.value}${item.fact.unit ? ` ${item.fact.unit}` : ""}`,
            date: fmtDate(item.fact.sourceRecord?.sourceDate ?? item.fact.createdAt),
          });
        }

        filterSections.push(`  - Condition ${filter.displayLabel}:\n${lines.join("\n")}`);
        matchedPositiveFilters.add(`${filter.kind}:${filter.token}`);
      }

      const requiredPositiveCount = args.query.filters.length;
      if (requiredPositiveCount > 0) {
        if (args.query.mode === "and" && matchedPositiveFilters.size !== requiredPositiveCount) return null;
        if (args.query.mode === "or" && matchedPositiveFilters.size === 0) return null;
      }

      return {
        portName: port.name,
        rankValue: matchedPositiveFilters.size,
        lines: [`- ${port.name}${port.country ? `, ${port.country}` : ""}:`, ...filterSections],
      };
    })
    .filter((item): item is { portName: string; rankValue: number; lines: string[] } => Boolean(item))
    .sort((a, b) => b.rankValue - a.rankValue || a.portName.localeCompare(b.portName));

  if (matches.length === 0) {
    const label = args.query.filters
      .map((filter) => describeDeterministicFilter(filter))
      .join(args.query.mode === "or" ? " or " : " + ");
    return {
      answer: `No ports in the current Port Intelligence DB match: ${label}.`,
      highlightedPorts: [] as string[],
      matchedLocations: [] as MatchedLocation[],
      resultRows: [] as ResultRow[],
    };
  }

  let intro = "Ports matching all requested filters:";
  if (args.query.scope === "terminal") {
    intro = args.query.portContextName
      ? `Matching terminals in ${args.query.portContextName}:`
      : "Matching terminals:";
  } else if (args.query.scope === "berth") {
    intro = args.query.terminalContextName
      ? `Matching berths in ${args.query.terminalContextName}:`
      : args.query.portContextName
        ? `Matching berths in ${args.query.portContextName}:`
        : "Matching berths:";
  } else if (args.query.mode === "or") {
    intro = "Ports matching any requested filter:";
  }

  if (args.query.filters.length === 1) {
    const firstFilter = args.query.filters[0];
    if (firstFilter.kind === "numeric" || firstFilter.kind === "numeric_range") {
      const numericLabel = NUMERIC_PARAMETER_CONFIG.find((item) => item.parameter === firstFilter.parameter)?.label ?? firstFilter.parameter;
      const numericConstraint =
        firstFilter.kind === "numeric_range" ? formatRange(firstFilter) : formatComparator(firstFilter);
      if (args.query.scope === "terminal") {
        intro = args.query.portContextName
          ? `Terminals in ${args.query.portContextName} with ${numericLabel} ${numericConstraint}:`
          : `Terminals with ${numericLabel} ${numericConstraint}:`;
      } else if (args.query.scope === "berth") {
        intro = args.query.terminalContextName
          ? `Berths in ${args.query.terminalContextName} with ${numericLabel} ${numericConstraint}:`
          : args.query.portContextName
            ? `Berths in ${args.query.portContextName} with ${numericLabel} ${numericConstraint}:`
            : `Berths with ${numericLabel} ${numericConstraint}:`;
      } else {
        intro = `Ports with ${numericLabel} ${numericConstraint}:`;
      }
    } else if (firstFilter.kind === "capability") {
      intro =
        args.query.scope === "terminal"
          ? `Matching terminals for ${firstFilter.displayLabel}:`
          : args.query.scope === "berth"
            ? `Matching berths for ${firstFilter.displayLabel}:`
            : `Ports matching ${firstFilter.displayLabel}:`;
    } else if (firstFilter.kind === "country") {
      intro = `Ports in ${firstFilter.displayLabel}:`;
    } else {
      intro =
        args.query.scope === "terminal"
          ? `Matching terminals with condition ${firstFilter.displayLabel}:`
          : args.query.scope === "berth"
            ? `Matching berths with condition ${firstFilter.displayLabel}:`
            : `Ports matching condition ${firstFilter.displayLabel}:`;
    }
  }

  return {
    answer: [
      intro,
      ...matches.flatMap((match) => match.lines),
    ].join("\n"),
    highlightedPorts: matches.map((match) => match.portName),
    matchedLocations: Array.from(
      new Map(
        matchedLocations.map((item) => [
          `${item.portName}__${item.portCountry ?? ""}__${item.terminalName ?? ""}__${item.berthName ?? ""}`,
          item,
        ])
      ).values()
    ),
    resultRows: Array.from(
      new Map(
        resultRows.map((row) => [
          `${row.portName}__${row.terminalName ?? ""}__${row.berthName ?? ""}__${row.matchLabel}__${row.matchValue}`,
          row,
        ])
      ).values()
    ).sort((a, b) => a.portName.localeCompare(b.portName) || (a.terminalName ?? "").localeCompare(b.terminalName ?? "") || (a.berthName ?? "").localeCompare(b.berthName ?? "") || a.matchLabel.localeCompare(b.matchLabel)),
  };
}

export async function POST(req: NextRequest) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "OpenAI API key is not configured on the server." },
        { status: 500 }
      );
    }

    const body = await req.json().catch(() => null);
    if (!body || !Array.isArray(body.messages) || !body.messages.length) {
      return NextResponse.json(
        { error: "Missing required field 'messages' in request body." },
        { status: 400 }
      );
    }

    const incomingMessages: { role: "user" | "assistant"; content: string }[] =
      body.messages;
    const latestUserMessage =
      [...incomingMessages].reverse().find((message) => message.role === "user")?.content ?? "";
    const routingQuestion = extractRawUserQuestion(latestUserMessage);
    const isSummaryRequest = isSummaryOverviewRequest(routingQuestion);

    const ports = await prisma.port.findMany({
      include: {
        facts: {
          include: {
            sourceRecord: true,
            terminal: true,
            berth: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { name: "asc" },
      take: 100,
    });

    const semanticPlannedQuery = await planSemanticFilterQuery(routingQuestion, ports).catch((error) => {
      console.warn("Semantic planner fallback:", error);
      return null;
    });
    const deterministicQuery =
      semanticPlannedQuery ?? parseDeterministicQuery(routingQuestion, ports);
    const bunkerQuery = parseBunkerQuestion(routingQuestion, ports);
    const restrictionQuery = parseRestrictionQuestion(routingQuestion, ports);
    const summaryContext = parseSummaryContext(latestUserMessage, routingQuestion, ports);

    if (!ports.length) {
      return NextResponse.json(
        {
          answer:
            "Port Intelligence DB is currently empty. Please ingest some port info first.",
        },
        { status: 200 }
      );
    }

    if (isSummaryRequest && summaryContext) {
      const summaryAnswer = buildSummaryOverviewAnswer({
        ports,
        query: summaryContext,
      });
      return NextResponse.json(summaryAnswer, { status: 200 });
    }

    if (!isSummaryRequest && bunkerQuery) {
      const bunkerAnswer = buildBunkerAnswer({
        ports,
        query: bunkerQuery,
      });
      return NextResponse.json(bunkerAnswer, { status: 200 });
    }

    if (!isSummaryRequest && restrictionQuery) {
      const restrictionAnswer = buildRestrictionAnswer({
        ports,
        query: restrictionQuery,
      });
      return NextResponse.json(restrictionAnswer, { status: 200 });
    }

    if (
      !isSummaryRequest &&
      deterministicQuery.filters.length > 0 &&
      /\bports?\b|\bterminals?\b|\bberths?\b|порты|терминал|причал/i.test(routingQuestion)
    ) {
      const deterministic = buildDeterministicFilterAnswer({
        ports,
        query: deterministicQuery,
      });
      return NextResponse.json(deterministic, { status: 200 });
    }

    const contextBlocks: string[] = [];

    for (const port of ports) {
      const portHeader = `=== PORT: ${port.name}${port.country ? ", " + port.country : ""} ===`;
      const conflictMap = new Map<string, Set<string>>();
      const resolvedFacts = buildOperationalView({
        portName: port.name,
        facts: port.facts,
      });
      const inferredCapabilities = inferCapabilities({
        portName: port.name,
        facts: port.facts,
      });
      const evidenceFrequencyLines = buildEvidenceFrequencyLines({
        portName: port.name,
        facts: port.facts,
      });

      for (const fact of port.facts) {
        const label = scopeLabel(
          port.name,
          fact.scope,
          fact.terminal?.name,
          fact.berth?.name
        );
        const key = `${label}__${fact.category.trim().toLowerCase()}`;
        const value = `${fact.value}${fact.unit ? ` ${fact.unit}` : ""}`.trim();
        if (!conflictMap.has(key)) {
          conflictMap.set(key, new Set());
        }
        conflictMap.get(key)!.add(value);
      }

      const factLines = port.facts.map((fact) => {
        const label = scopeLabel(
          port.name,
          fact.scope,
          fact.terminal?.name,
          fact.berth?.name
        );
        const key = `${label}__${fact.category.trim().toLowerCase()}`;
        const hasConflict = (conflictMap.get(key)?.size ?? 0) > 1;
        const valuePart = `${fact.value}${fact.unit ? ` ${fact.unit}` : ""}`.trim();
        const sourcePart = fact.sourceRecord.sourceName || "unknown source";
        const datePart = fmtDate(fact.sourceRecord.sourceDate ?? fact.createdAt);
        const notesPart = fact.notes ? ` (${fact.notes})` : "";
        const conflictFlag = hasConflict ? " ⚠️ VALUE VARIATION" : "";
        const parsedConditions = parseOperationalConditions(
          fact.value,
          fact.unit,
          fact.notes
        );
        const conditionTags = conditionTagsFromParsed(parsedConditions);
        const conditionPart =
          conditionTags.length > 0 ? ` [conditions: ${conditionTags.join(", ")}]` : "";

        return `  [${fact.scope}] ${label} | ${fact.category}: ${valuePart} — ${sourcePart} (${datePart})${notesPart}${conditionPart}${conflictFlag}`;
      });

      const resolvedLines = resolvedFacts.map(
        (fact) =>
          `  [RESOLVED ${fact.scope}] ${fact.locationLabel} | ${fact.category}: ${fact.summary} | status=${fact.status} | observations=${fact.observationCount}`
      );
      const capabilityLines = inferredCapabilities.map(
        (capability) =>
          `  [INFERRED CAPABILITY ${capability.scope}] ${capability.locationLabel} | ${capability.capability} | confidence=${capability.confidence} | reason=${capability.reason} | signals=${capability.signals.join(", ")}`
      );
      const bunkerModeLines = buildBunkerModeContextLines(port);

      contextBlocks.push([
        portHeader,
        ...capabilityLines,
        ...bunkerModeLines,
        ...evidenceFrequencyLines,
        ...resolvedLines,
        ...factLines,
      ].join("\n"));
    }

    const dbContext = contextBlocks.join("\n\n");
    const systemWithContext = `${systemPrompt}${restrictionQuestionInstruction(routingQuestion)}${bunkerQuestionInstruction(routingQuestion)}\n\n=== PORT INTELLIGENCE DB ===\n\n${dbContext}`;
    const thresholdFilterInstruction = "";

    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "assistant_response",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              answer: { type: "string" },
              highlightedPorts: {
                type: "array",
                items: { type: "string" },
              },
              matchedLocations: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    portName: { type: "string" },
                    portCountry: { type: "string" },
                    terminalName: { type: "string" },
                    berthName: { type: "string" },
                  },
                  required: ["portName"],
                },
              },
              resultRows: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    portName: { type: "string" },
                    terminalName: { type: "string" },
                    berthName: { type: "string" },
                    matchLabel: { type: "string" },
                    matchValue: { type: "string" },
                    date: { type: "string" },
                  },
                  required: ["portName", "matchLabel", "matchValue", "date"],
                },
              },
            },
            required: ["answer", "highlightedPorts", "matchedLocations", "resultRows"],
          },
        },
      },
      messages: [
        { role: "system", content: `${systemWithContext}${thresholdFilterInstruction}` },
        {
          role: "system",
          content:
            'Return strictly valid JSON with keys "answer", "highlightedPorts", "matchedLocations", and "resultRows". "highlightedPorts" must be an array of exact port names from the DB context that should be highlighted on the map for this answer. "matchedLocations" should contain exact port/terminal/berth hits when you know them; otherwise return an empty array. "resultRows" should be an array of compact structured matches when applicable; otherwise return an empty array.',
        },
        ...incomingMessages,
      ],
    });

    const rawContent =
      response.choices[0]?.message?.content ||
      '{"answer":"Sorry, I could not generate an answer.","highlightedPorts":[],"matchedLocations":[],"resultRows":[]}';
    const parsed = JSON.parse(rawContent) as {
      answer?: string;
      highlightedPorts?: string[];
      matchedLocations?: MatchedLocation[];
      resultRows?: ResultRow[];
    };
    const rawAnswer =
      typeof parsed.answer === "string" && parsed.answer.trim()
        ? parsed.answer
        : "Sorry, I could not generate an answer.";
    const highlightedPorts = Array.isArray(parsed.highlightedPorts)
      ? parsed.highlightedPorts.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    const matchedLocations = Array.isArray(parsed.matchedLocations)
      ? parsed.matchedLocations.filter(
          (item): item is MatchedLocation =>
            Boolean(item) && typeof item.portName === "string" && item.portName.trim().length > 0
        )
      : [];
    const resultRows = Array.isArray(parsed.resultRows)
      ? parsed.resultRows.filter(
          (item): item is ResultRow =>
            Boolean(item) &&
            typeof item.portName === "string" &&
            typeof item.matchLabel === "string" &&
            typeof item.matchValue === "string" &&
            typeof item.date === "string"
        )
      : [];

    return NextResponse.json({ answer: rawAnswer, highlightedPorts, matchedLocations, resultRows }, { status: 200 });
  } catch (err) {
    console.error("ASSISTANT FATAL ERROR:", err);
    const schemaMismatchMessage = getSchemaMismatchMessage(err);
    const databaseUnavailableMessage = getDatabaseUnavailableMessage(err);
    return NextResponse.json(
      {
        error:
          schemaMismatchMessage ??
          databaseUnavailableMessage ??
          "Internal server error in Port Assistant. See server logs for details.",
      },
      { status: schemaMismatchMessage || databaseUnavailableMessage ? 503 : 500 }
    );
  }
}
