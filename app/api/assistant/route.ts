import { NextRequest, NextResponse } from "next/server";
import { PortFactScope } from "@prisma/client";
import OpenAI from "openai";
import { prisma } from "@/lib/prisma";
import { getDatabaseUnavailableMessage, getSchemaMismatchMessage } from "@/lib/db-errors";
import { buildOperationalView } from "@/lib/operational-view";
import { conditionTagsFromParsed, parseOperationalConditions } from "@/lib/condition-parsing";
import { inferCapabilities } from "@/lib/capability-inference";

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

type DeterministicFilter = NumericFilter | CapabilityFilter | ConditionFilter;

type MatchedLocation = {
  portName: string;
  terminalName?: string;
  berthName?: string;
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
`.trim();

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "date unknown";
  return new Date(d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
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

function buildEvidenceFrequencyLines(args: {
  portName: string;
  facts: Array<{
    scope: PortFactScope;
    category: string;
    value: string;
    unit: string | null;
    notes: string | null;
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

    const displayValue = observationDisplayValue({
      category,
      value: fact.value,
      unit: fact.unit,
      notes: fact.notes,
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

function parseDeterministicFilters(question: string): DeterministicFilter[] {
  const lower = question.toLowerCase();
  if (isSummaryOverviewRequest(question)) return [];
  const filters: DeterministicFilter[] = [];

  for (const config of NUMERIC_PARAMETER_CONFIG) {
    for (const alias of config.aliases) {
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
    if (config.aliases.some((alias) => lower.includes(alias))) {
      filters.push({
        kind: "capability",
        capability: config.capability,
        displayLabel: config.displayLabel,
      });
    }
  }

  for (const config of CONDITION_FILTERS) {
    if (config.aliases.some((alias) => lower.includes(alias))) {
      filters.push({
        kind: "condition",
        token: config.token,
        displayLabel: config.displayLabel,
      });
    }
  }

  const seen = new Set<string>();
  return filters.filter((filter) => {
    const key =
      filter.kind === "numeric"
        ? `${filter.kind}:${filter.parameter}:${filter.comparator}:${filter.threshold}`
        : filter.kind === "capability"
          ? `${filter.kind}:${filter.capability}`
          : `${filter.kind}:${filter.token}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatComparator(filter: NumericFilter) {
  if (filter.comparator === "gt") return `over ${filter.displayThreshold}`;
  if (filter.comparator === "gte") return `at least ${filter.displayThreshold}`;
  if (filter.comparator === "lt") return `under ${filter.displayThreshold}`;
  return `at most ${filter.displayThreshold}`;
}

function buildDeterministicFilterAnswer(args: {
  ports: PortForFilters[];
  filters: DeterministicFilter[];
}) {
  const matchedLocations: MatchedLocation[] = [];
  const resultRows: ResultRow[] = [];
  const matches = args.ports
    .map((port) => {
      const inferredCapabilities = inferCapabilities({
        portName: port.name,
        facts: port.facts,
      });

      const filterSections: string[] = [];

      for (const filter of args.filters) {
        if (filter.kind === "numeric") {
          const config = NUMERIC_PARAMETER_CONFIG.find((item) => item.parameter === filter.parameter)!;
          const qualifyingFacts = port.facts
            .filter((fact) => deriveFilterCategory(fact) === filter.parameter)
            .map((fact) => {
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
                  };
            })
            .filter((item): item is { fact: FactForFilters; numericValue: number } =>
              Boolean(item && compareNumeric(item.numericValue, filter.comparator, filter.threshold))
            )
            .sort((a, b) => {
              const aTime = a.fact.sourceRecord?.sourceDate?.getTime() ?? a.fact.createdAt.getTime();
              const bTime = b.fact.sourceRecord?.sourceDate?.getTime() ?? b.fact.createdAt.getTime();
              return b.numericValue - a.numericValue || bTime - aTime;
            });

          if (qualifyingFacts.length === 0) return null;

          const byLocation = new Map<
            string,
            {
              locationLabel: string;
              bestValue: number;
              line: string;
            }
          >();

          for (const item of qualifyingFacts) {
            const location =
              item.fact.scope === PortFactScope.BERTH
                ? [item.fact.terminal?.name, item.fact.berth?.name].filter(Boolean).join(" > ")
                : item.fact.scope === PortFactScope.TERMINAL
                  ? item.fact.terminal?.name ?? port.name
                  : port.name;
            const locationKey = location.toLowerCase();
            const date = fmtDate(item.fact.sourceRecord?.sourceDate ?? item.fact.createdAt);
            const conditionText = item.fact.notes ? ` (${item.fact.notes})` : "";
            const line = `    - ${location} — ${item.fact.value}${item.fact.unit ? ` ${item.fact.unit}` : ""}${conditionText} (${date})`;

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

          for (const item of qualifyingFacts) {
            matchedLocations.push({
              portName: port.name,
              terminalName: item.fact.terminal?.name ?? undefined,
              berthName: item.fact.berth?.name ?? undefined,
            });
            resultRows.push({
              portName: port.name,
              terminalName: item.fact.terminal?.name ?? undefined,
              berthName: item.fact.berth?.name ?? undefined,
              matchLabel: `${config.label} ${formatComparator(filter)}`,
              matchValue: `${item.fact.value}${item.fact.unit ? ` ${item.fact.unit}` : ""}${item.fact.notes ? ` (${item.fact.notes})` : ""}`,
              date: fmtDate(item.fact.sourceRecord?.sourceDate ?? item.fact.createdAt),
            });
          }

          filterSections.push(`  - ${config.label} ${formatComparator(filter)}:\n${lines.join("\n")}`);
          continue;
        }

        if (filter.kind === "capability") {
          const matchingCapabilities = inferredCapabilities
            .filter((capability) => capability.capability.toLowerCase().includes(filter.capability))
            .map((capability) => `    - ${capability.locationLabel} (${capability.reason})`);

          if (matchingCapabilities.length === 0) return null;
          for (const capability of inferredCapabilities.filter((item) =>
            item.capability.toLowerCase().includes(filter.capability)
          )) {
            const parts = capability.locationLabel.split(" > ");
            matchedLocations.push({
              portName: parts[0] ?? port.name,
              terminalName: parts[1] || undefined,
              berthName: parts[2] || undefined,
            });
            resultRows.push({
              portName: parts[0] ?? port.name,
              terminalName: parts[1] || undefined,
              berthName: parts[2] || undefined,
              matchLabel: filter.displayLabel,
              matchValue: capability.reason,
              date: "Inferred",
            });
          }
          filterSections.push(`  - ${filter.displayLabel}:\n${matchingCapabilities.join("\n")}`);
          continue;
        }

        const matchingConditionFacts = port.facts
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

        if (matchingConditionFacts.length === 0) return null;

        const lines = matchingConditionFacts.slice(0, 6).map((item) => {
          const location =
            item.fact.scope === PortFactScope.BERTH
              ? [item.fact.terminal?.name, item.fact.berth?.name].filter(Boolean).join(" > ")
              : item.fact.scope === PortFactScope.TERMINAL
                ? item.fact.terminal?.name ?? port.name
                : port.name;
          const date = fmtDate(item.fact.sourceRecord?.sourceDate ?? item.fact.createdAt);
          return `    - ${location} | ${item.fact.category}: ${item.fact.value}${item.fact.unit ? ` ${item.fact.unit}` : ""} (${date})`;
        });

        for (const item of matchingConditionFacts) {
          matchedLocations.push({
            portName: port.name,
            terminalName: item.fact.terminal?.name ?? undefined,
            berthName: item.fact.berth?.name ?? undefined,
          });
          resultRows.push({
            portName: port.name,
            terminalName: item.fact.terminal?.name ?? undefined,
            berthName: item.fact.berth?.name ?? undefined,
            matchLabel: `Condition ${filter.displayLabel}`,
            matchValue: `${item.fact.category}: ${item.fact.value}${item.fact.unit ? ` ${item.fact.unit}` : ""}`,
            date: fmtDate(item.fact.sourceRecord?.sourceDate ?? item.fact.createdAt),
          });
        }

        filterSections.push(`  - Condition ${filter.displayLabel}:\n${lines.join("\n")}`);
      }

      if (filterSections.length !== args.filters.length) return null;

      return {
        portName: port.name,
        rankValue: filterSections.length,
        lines: [`- ${port.name}${port.country ? `, ${port.country}` : ""}:`, ...filterSections],
      };
    })
    .filter((item): item is { portName: string; rankValue: number; lines: string[] } => Boolean(item))
    .sort((a, b) => b.rankValue - a.rankValue || a.portName.localeCompare(b.portName));

  if (matches.length === 0) {
    const label = args.filters
      .map((filter) =>
        filter.kind === "numeric"
          ? `${NUMERIC_PARAMETER_CONFIG.find((item) => item.parameter === filter.parameter)?.label ?? filter.parameter} ${formatComparator(filter)}`
          : filter.kind === "capability"
            ? filter.displayLabel
            : `Condition ${filter.displayLabel}`
      )
      .join(" + ");
    return {
      answer: `No ports in the current Port Intelligence DB match: ${label}.`,
      highlightedPorts: [] as string[],
      matchedLocations: [] as MatchedLocation[],
      resultRows: [] as ResultRow[],
    };
  }

  let intro = "Ports matching all requested filters:";
  if (args.filters.length === 1) {
    const firstFilter = args.filters[0];
    if (firstFilter.kind === "numeric") {
      intro = `Ports with ${NUMERIC_PARAMETER_CONFIG.find((item) => item.parameter === firstFilter.parameter)?.label ?? firstFilter.parameter} ${formatComparator(firstFilter)}:`;
    } else if (firstFilter.kind === "capability") {
      intro = `Ports matching ${firstFilter.displayLabel}:`;
    } else {
      intro = `Ports matching condition ${firstFilter.displayLabel}:`;
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
          `${item.portName}__${item.terminalName ?? ""}__${item.berthName ?? ""}`,
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
    const isSummaryRequest = isSummaryOverviewRequest(latestUserMessage);
    const deterministicFilters = parseDeterministicFilters(latestUserMessage);

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

    if (!ports.length) {
      return NextResponse.json(
        {
          answer:
            "Port Intelligence DB is currently empty. Please ingest some port info first.",
        },
        { status: 200 }
      );
    }

    if (!isSummaryRequest && deterministicFilters.length > 0 && /\bports?\b|порты/i.test(latestUserMessage)) {
      const deterministic = buildDeterministicFilterAnswer({
        ports,
        filters: deterministicFilters,
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

      contextBlocks.push([
        portHeader,
        ...capabilityLines,
        ...evidenceFrequencyLines,
        ...resolvedLines,
        ...factLines,
      ].join("\n"));
    }

    const dbContext = contextBlocks.join("\n\n");
    const systemWithContext = `${systemPrompt}\n\n=== PORT INTELLIGENCE DB ===\n\n${dbContext}`;
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
