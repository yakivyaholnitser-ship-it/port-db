import { PortFactScope } from "@prisma/client";
import {
  conditionTagsFromParsed,
  parseOperationalConditions,
} from "@/lib/condition-parsing";
import {
  berthWideConditionTags,
  parseCombinedBerthValues,
} from "@/lib/berth-decomposition";

type FactWithContext = {
  id: number;
  createdAt: Date;
  scope: PortFactScope;
  category: string;
  value: string;
  unit: string | null;
  notes: string | null;
  rawSnippet: string | null;
  sourceRecordId: number;
  sourceRecord: {
    sourceName: string | null;
    sourceDate: Date | null;
  };
  terminal: { name: string } | null;
  berth: { name: string } | null;
};

export type OperationalObservation = {
  factId: number;
  value: string;
  unit: string | null;
  displayValue: string;
  conditionTags: string[];
  berthBreakdown: {
    berthName: string;
    displayValue: string;
    conditionTags: string[];
  }[];
  notes: string | null;
  sourceName: string | null;
  sourceDate: string | null;
  sourceRecordId: number;
};

export type ResolvedOperationalFact = {
  key: string;
  category: string;
  scope: PortFactScope;
  locationLabel: string;
  summary: string;
  latestEntries: OperationalObservation[];
  status: "clear" | "multi_observation" | "conflict";
  observationCount: number;
  distinctValueCount: number;
  observations: OperationalObservation[];
};

const RESTRICTION_CATEGORIES = [
  "draft",
  "density",
  "air_draft",
  "loa",
  "beam",
  "dwt",
  "tide",
  "ukc",
  "trim",
  "restriction",
];

const PRODUCTION_CATEGORIES = [
  "gangs",
  "shifts",
  "load_rate",
  "discharge_rate",
  "production",
  "equipment",
];

function locationLabelForFact(portName: string, fact: FactWithContext) {
  if (fact.scope === PortFactScope.BERTH) {
    return [fact.terminal?.name, fact.berth?.name].filter(Boolean).join(" / ") || portName;
  }
  if (fact.scope === PortFactScope.TERMINAL) {
    return fact.terminal?.name || portName;
  }
  return portName;
}

function factValue(fact: FactWithContext) {
  return `${fact.value}${fact.unit ? ` ${fact.unit}` : ""}`.trim();
}

function isDepthRelatedCategory(category: string) {
  const normalized = category.trim().toLowerCase();
  return normalized === "draft" || normalized === "air_draft" || normalized === "dwt";
}

function sameLocation(a: FactWithContext, b: FactWithContext) {
  return (
    a.scope === b.scope &&
    (a.terminal?.name ?? null) === (b.terminal?.name ?? null) &&
    (a.berth?.name ?? null) === (b.berth?.name ?? null)
  );
}

function mentionedBerthNames(fact: FactWithContext) {
  return parseOperationalConditions(fact.value, fact.notes, fact.rawSnippet).mentionedBerths;
}

function findRelatedDensity(fact: FactWithContext, allFacts: FactWithContext[]) {
  if (!isDepthRelatedCategory(fact.category)) return null;

  const density = allFacts.find(
    (candidate) =>
      candidate.sourceRecordId === fact.sourceRecordId &&
      candidate.category.trim().toLowerCase() === "density" &&
      sameLocation(candidate, fact)
  );

  if (density) return factValue(density);

  if (fact.scope === PortFactScope.TERMINAL) {
    const berthMentions = mentionedBerthNames(fact);
    const berthDensity = allFacts.find(
      (candidate) =>
        candidate.category.trim().toLowerCase() === "density" &&
        candidate.scope === PortFactScope.BERTH &&
        candidate.terminal?.name === fact.terminal?.name &&
        berthMentions.includes(candidate.berth?.name ?? "")
    );

    if (berthDensity) {
      return `${berthDensity.berth?.name}: ${factValue(berthDensity)}`;
    }
  }

  return null;
}

function findDensityForBerth(args: {
  terminalName: string | null | undefined;
  berthName: string;
  allFacts: FactWithContext[];
}) {
  const matches = args.allFacts
    .filter(
      (candidate) =>
        candidate.category.trim().toLowerCase() === "density" &&
        candidate.scope === PortFactScope.BERTH &&
        candidate.terminal?.name === args.terminalName &&
        candidate.berth?.name === args.berthName
    )
    .sort((a, b) => {
      const aDate = a.sourceRecord.sourceDate ?? a.createdAt;
      const bDate = b.sourceRecord.sourceDate ?? b.createdAt;
      return bDate.getTime() - aDate.getTime();
    });

  return matches[0] ?? null;
}

function displayObservationValue(fact: FactWithContext, allFacts: FactWithContext[]) {
  const base = factValue(fact);
  const density = findRelatedDensity(fact, allFacts);
  if (density) {
    return `${base} @ density ${density}`;
  }
  return base;
}

function findRelatedTide(fact: FactWithContext, allFacts: FactWithContext[]) {
  if (!isDepthRelatedCategory(fact.category)) return null;

  return allFacts.find((candidate) => {
    if (candidate.category.trim().toLowerCase() !== "tide") return false;
    if (sameLocation(candidate, fact)) return true;
    return (
      fact.terminal?.name &&
      candidate.terminal?.name === fact.terminal?.name &&
      candidate.scope === PortFactScope.TERMINAL
    );
  });
}

function extractConditionTags(fact: FactWithContext, allFacts: FactWithContext[]) {
  const parsed = parseOperationalConditions(
    fact.value,
    fact.unit,
    fact.notes,
    fact.rawSnippet
  );
  const tags = new Set<string>();
  const depthRelated = isDepthRelatedCategory(fact.category);

  for (const tag of conditionTagsFromParsed(parsed)) {
    if (
      !depthRelated &&
      (tag.startsWith("Density ") ||
        tag === "Zero tide" ||
        tag === "HW" ||
        tag === "LW" ||
        tag === "Tide affected" ||
        tag.startsWith("Tide "))
    ) {
      continue;
    }
    tags.add(tag);
  }

  if (depthRelated) {
    const density = findRelatedDensity(fact, allFacts);
    if (density) {
      tags.add(`Density ${density}`);
    }
  }

  if (depthRelated) {
    const tide = findRelatedTide(fact, allFacts);
    if (tide) {
      tags.add(`Tide ${factValue(tide)}`);
    }
  }

  return Array.from(tags);
}

function buildBerthBreakdown(fact: FactWithContext, allFacts: FactWithContext[]) {
  if (fact.scope !== PortFactScope.TERMINAL || !isDepthRelatedCategory(fact.category)) {
    return [];
  }

  const breakdown = parseCombinedBerthValues({
    value: fact.value,
    unit: fact.unit,
    notes: fact.notes,
  });

  if (breakdown.length === 0) return [];

  const wideConditions = berthWideConditionTags(fact.value, fact.unit, fact.notes);

  return breakdown.map((item) => {
    const tags = new Set<string>(wideConditions.sharedTags);
    const density = findDensityForBerth({
      terminalName: fact.terminal?.name,
      berthName: item.berthName,
      allFacts,
    });
    if (density) {
      tags.add(`Density ${factValue(density)}`);
    }

    return {
      berthName: item.berthName,
      displayValue: item.valueText,
      conditionTags: Array.from(tags),
    };
  });
}

function summaryForObservations(observations: OperationalObservation[]) {
  if (observations.length === 0) return "No observations.";

  const latest = observations.slice(0, 3).map((item) =>
    item.conditionTags.length > 0
      ? `${item.displayValue} [${item.conditionTags.join(", ")}]`
      : item.displayValue
  );
  return latest.join(" | ");
}

function categoryBucket(category: string) {
  const normalized = category.trim().toLowerCase();
  if (RESTRICTION_CATEGORIES.includes(normalized)) return 0;
  if (PRODUCTION_CATEGORIES.includes(normalized)) return 1;
  return 2;
}

export function buildOperationalView(args: {
  portName: string;
  facts: FactWithContext[];
}): ResolvedOperationalFact[] {
  const groups = new Map<string, FactWithContext[]>();

  for (const fact of args.facts) {
    const category = fact.category.trim().toLowerCase();
    const key = `${fact.scope}__${locationLabelForFact(args.portName, fact)}__${category}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(fact);
  }

  return Array.from(groups.entries())
    .map(([key, facts]) => {
      const orderedFacts = [...facts].sort((a, b) => {
        const aDate = a.sourceRecord.sourceDate ?? a.createdAt;
        const bDate = b.sourceRecord.sourceDate ?? b.createdAt;
        return bDate.getTime() - aDate.getTime();
      });

      const observations = orderedFacts.map((fact) => ({
        factId: fact.id,
        value: fact.value,
        unit: fact.unit,
        displayValue: displayObservationValue(fact, orderedFacts),
        conditionTags: extractConditionTags(fact, args.facts),
        berthBreakdown: buildBerthBreakdown(fact, args.facts),
        notes: fact.notes,
        sourceName: fact.sourceRecord.sourceName,
        sourceDate: (fact.sourceRecord.sourceDate ?? fact.createdAt).toISOString(),
        sourceRecordId: fact.sourceRecordId,
      }));

      const distinctValueCount = new Set(observations.map((item) => item.displayValue)).size;
      const normalizedCategory = (orderedFacts[0]?.category ?? "other").trim().toLowerCase();
      const status =
        distinctValueCount <= 1
          ? "clear"
          : normalizedCategory === "other"
            ? "multi_observation"
            : distinctValueCount === observations.length
              ? "conflict"
              : "multi_observation";

      return {
        key,
        category: orderedFacts[0]?.category ?? "other",
        scope: orderedFacts[0]?.scope ?? PortFactScope.PORT,
        locationLabel: locationLabelForFact(args.portName, orderedFacts[0]!),
        summary: summaryForObservations(observations),
        latestEntries: observations.slice(0, 3),
        status,
        observationCount: observations.length,
        distinctValueCount,
        observations,
      } satisfies ResolvedOperationalFact;
    })
    .sort((a, b) => {
      const bucketDelta = categoryBucket(a.category) - categoryBucket(b.category);
      if (bucketDelta !== 0) return bucketDelta;

      if (a.status !== b.status) {
        const order = { conflict: 0, multi_observation: 1, clear: 2 };
        return order[a.status] - order[b.status];
      }
      return a.category.localeCompare(b.category);
    });
}
