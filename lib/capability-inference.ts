import { PortFactScope } from "@prisma/client";

type FactLike = {
  scope: PortFactScope;
  category: string;
  value: string;
  unit: string | null;
  notes: string | null;
  rawSnippet?: string | null;
  terminal?: { name: string } | null;
  berth?: { name: string } | null;
};

export type InferredCapability = {
  locationLabel: string;
  scope: PortFactScope;
  capability: string;
  confidence: "high" | "medium";
  reason: string;
  signals: string[];
};

const GRAIN_PATTERNS: Array<{ pattern: RegExp; signal: string; confidence: "high" | "medium" }> = [
  { pattern: /\bgrain\s+elevator\b/i, signal: "grain elevator", confidence: "high" },
  { pattern: /\bgrain\s+loader\b/i, signal: "grain loader", confidence: "high" },
  { pattern: /\bgrain\s+spout\b/i, signal: "grain spout", confidence: "high" },
  { pattern: /\bgrain\s+terminal\b/i, signal: "grain terminal", confidence: "high" },
  { pattern: /\bgrain\s+berth\b/i, signal: "grain berth", confidence: "high" },
  { pattern: /\bbarley\s*\/\s*grain\b/i, signal: "barley / grain cargo reference", confidence: "high" },
  { pattern: /\b(grain|wheat|corn|maize|soybeans?|soybean meal|canola|rapeseed|sorghum)\b/i, signal: "grain cargo keyword", confidence: "medium" },
];

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

export function inferCapabilities(params: {
  portName: string;
  facts: FactLike[];
}): InferredCapability[] {
  const { portName, facts } = params;
  const grouped = new Map<
    string,
    {
      scope: PortFactScope;
      locationLabel: string;
      signals: Map<string, "high" | "medium">;
    }
  >();

  for (const fact of facts) {
    const haystack = [
      fact.category,
      fact.value,
      fact.unit ?? "",
      fact.notes ?? "",
      fact.rawSnippet ?? "",
      fact.terminal?.name ?? "",
      fact.berth?.name ?? "",
    ]
      .join(" ")
      .trim();

    const locationLabel = scopeLabel(
      portName,
      fact.scope,
      fact.terminal?.name,
      fact.berth?.name
    );
    const key = `${fact.scope}__${locationLabel}`;

    for (const candidate of GRAIN_PATTERNS) {
      if (!candidate.pattern.test(haystack)) {
        continue;
      }

      if (!grouped.has(key)) {
        grouped.set(key, {
          scope: fact.scope,
          locationLabel,
          signals: new Map(),
        });
      }

      const existing = grouped.get(key)!.signals.get(candidate.signal);
      if (!existing || (existing === "medium" && candidate.confidence === "high")) {
        grouped.get(key)!.signals.set(candidate.signal, candidate.confidence);
      }
    }
  }

  return Array.from(grouped.values())
    .map((entry) => {
      const signals = Array.from(entry.signals.entries());
      if (!signals.length) {
        return null;
      }

      const hasHigh = signals.some(([, confidence]) => confidence === "high");
      const confidence: "high" | "medium" = hasHigh ? "high" : "medium";

      return {
        locationLabel: entry.locationLabel,
        scope: entry.scope,
        capability: "grain-capable",
        confidence,
        reason: hasHigh
          ? "Strong grain-handling equipment or terminal wording is present in the record."
          : "Cargo wording strongly suggests grain handling capability.",
        signals: signals.map(([signal]) => signal).sort(),
      } satisfies InferredCapability;
    })
    .filter((entry): entry is InferredCapability => Boolean(entry))
    .sort((a, b) => a.locationLabel.localeCompare(b.locationLabel));
}
