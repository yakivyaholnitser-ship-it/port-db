type AliasCandidate = {
  id: number;
  name: string;
  normalizedName: string;
  aliases?: { normalizedName: string }[];
};

export function normalizeLocationName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizePortName(value: string): string {
  return value
    .replace(/\s*\([^)]*\)\s*$/i, "")
    .replace(/\b(Port of|Port)\s+/i, "")
    .replace(/\s+Port$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalizeLocationKey(value: string): string {
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

export function matchByAlias<T extends AliasCandidate>(
  rawName: string,
  candidates: T[],
  minimumScore = 0.74
): T | null {
  const rawKey = canonicalizeLocationKey(rawName);
  if (!rawKey) return null;

  for (const candidate of candidates) {
    if (candidate.normalizedName === rawKey) {
      return candidate;
    }
    if (candidate.aliases?.some((alias) => alias.normalizedName === rawKey)) {
      return candidate;
    }
  }

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

  return best && best.score >= minimumScore ? best.candidate : null;
}
