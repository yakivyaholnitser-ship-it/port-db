export type BunkerMode =
  | "anchorage_only"
  | "alongside_only"
  | "anchorage_or_alongside"
  | "truck_only"
  | "barge_only"
  | "not_available"
  | "conditional_mixed";

type BunkerSemanticFact = {
  category?: string | null;
  value: string;
  unit?: string | null;
  notes?: string | null;
  rawSnippet?: string | null;
};

function bunkerHaystack(fact: BunkerSemanticFact) {
  return [fact.value, fact.unit, fact.notes, fact.rawSnippet]
    .filter(Boolean)
    .join(" ")
    .replace(/where (?:the )?bunkering ops take place\?/gi, " ")
    .replace(/anchorage\s*\/\s*alongside\??/gi, " ")
    .replace(/what bunkers? to be consumed in port[^.:\n]*[:?]/gi, " ")
    .toLowerCase();
}

export function isBunkerFuelSpecFact(fact: BunkerSemanticFact) {
  const haystack = bunkerHaystack(fact);
  return (
    /\bwhat bunkers? to be consumed\b/.test(haystack) ||
    /\bbunker fuel sulphur\b|\bbunker fuel sulfur\b|\bfuel sulphur\b|\bfuel sulfur\b/.test(haystack) ||
    /\b<\s*0\.\d+%/.test(haystack) ||
    /\b0\.\d+%\s*sulphur\b|\b0\.\d+%\s*sulfur\b/.test(haystack) ||
    /\blow sulphur fuel oil\b|\blow sulfur fuel oil\b|\blsfo\b|\blsmgo\b/.test(haystack)
  );
}

export function isBunkerLocationFact(fact: BunkerSemanticFact) {
  const category = (fact.category ?? "").trim().toLowerCase();
  const haystack = bunkerHaystack(fact);

  if (category && category !== "bunker") return false;
  if (isBunkerFuelSpecFact(fact)) return false;

  return (
    /\bwhere (?:the )?bunkering ops take place\b/.test(haystack) ||
    /\bbunkering\b/.test(haystack) ||
    /\bbunkers?\b/.test(haystack) ||
    ((category === "bunker" || !category) &&
      /\banchorage\b|\balongside\b|\btruck only\b|\bbarge only\b|\bnot available\b/.test(haystack))
  );
}

export function parseBunkerModes(fact: BunkerSemanticFact): Set<BunkerMode> {
  const haystack = bunkerHaystack(fact);
  const modes = new Set<BunkerMode>();

  if (!isBunkerLocationFact(fact)) return modes;

  if (/\bno bunkers? available\b|\bnot available\b/.test(haystack)) {
    modes.add("not_available");
    return modes;
  }

  const hasTruckOnly = /\btruck only\b|\bsmall delivery via truck only\b/.test(haystack);
  const hasBargeOnly = /\bbarge only\b|\bonly ex barge\b|\bonly by barge\b/.test(haystack);

  if (hasTruckOnly) modes.add("truck_only");
  if (hasBargeOnly) modes.add("barge_only");

  const mentionsAnchorage =
    /\banchorage\b|\banchor(?:age)?\s+only\b|\binner harbour anchorage\b|\bport angeles anchorage\b|\bsf anchor\b/.test(
      haystack
    );
  const mentionsAlongside = /\balongside\b|\bat berth\b/.test(haystack);

  if (
    mentionsAnchorage &&
    !mentionsAlongside &&
    !/\botherwise\b/.test(haystack) &&
    !hasTruckOnly &&
    (/\bonly\b/.test(haystack) ||
      /^anchorage$/.test(haystack.trim()) ||
      /\bat anchorage\b/.test(haystack))
  ) {
    modes.add("anchorage_only");
  }

  if (mentionsAlongside && !mentionsAnchorage && /\bonly\b/.test(haystack)) {
    modes.add("alongside_only");
  }

  if (
    mentionsAnchorage &&
    mentionsAlongside &&
    !/\bonly at anchorage\b|\banchorage only\b|\bonly alongside\b/.test(haystack)
  ) {
    modes.add("anchorage_or_alongside");
  }

  if (
    /\botherwise\b/.test(haystack) ||
    /\bwhile\b.+\bonly\b/.test(haystack) ||
    /\bduring\b.+\bonly\b/.test(haystack) ||
    modes.size > 1
  ) {
    modes.add("conditional_mixed");
  }

  return modes;
}

export function bunkerModeLabel(mode: BunkerMode) {
  if (mode === "anchorage_only") return "Bunkering only at anchorage";
  if (mode === "alongside_only") return "Bunkering only alongside";
  if (mode === "anchorage_or_alongside") return "Bunkering at anchorage or alongside";
  if (mode === "truck_only") return "Bunkering by truck only";
  if (mode === "barge_only") return "Bunkering by barge only";
  if (mode === "conditional_mixed") return "Conditional / mixed bunkering arrangement";
  return "No bunkers available";
}

export function normalizeBunkerFact(fact: BunkerSemanticFact & { category?: string | null }) {
  const category = (fact.category ?? "").trim().toLowerCase();

  if (category === "bunker" && isBunkerFuelSpecFact(fact)) {
    return {
      category: "sulphur",
      value: fact.value,
      notes: fact.notes,
      rawSnippet: fact.rawSnippet ?? null,
      normalizedModes: [] as BunkerMode[],
    };
  }

  if (category !== "bunker" || !isBunkerLocationFact(fact)) {
    return {
      category: fact.category?.trim() ?? "other",
      value: fact.value,
      notes: fact.notes,
      rawSnippet: fact.rawSnippet ?? null,
      normalizedModes: [] as BunkerMode[],
    };
  }

  const modes = Array.from(parseBunkerModes(fact));
  if (modes.length === 0) {
    return {
      category: "bunker",
      value: fact.value,
      notes: fact.notes,
      rawSnippet: fact.rawSnippet ?? null,
      normalizedModes: [] as BunkerMode[],
    };
  }

  const primaryMode =
    modes.includes("conditional_mixed")
      ? "conditional_mixed"
      : modes[0];

  const normalizedNote = `Normalized bunker mode: ${primaryMode}.`;
  const notes = fact.notes?.trim()
    ? `${fact.notes.trim()} ${normalizedNote}`
    : normalizedNote;

  return {
    category: "bunker",
    value: bunkerModeLabel(primaryMode),
    notes,
    rawSnippet: fact.rawSnippet ?? null,
    normalizedModes: modes,
  };
}
