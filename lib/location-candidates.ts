import { canonicalizeLocationKey } from "@/lib/location-matching";

type FactLike = {
  locationLabel: string | null;
  notes: string | null;
  rawSnippet: string | null;
};

export type DerivedLocationNode = {
  id: string;
  name: string;
  berths: { id: string; name: string }[];
  derived: true;
};

function splitLocationLabel(label: string) {
  const berthTailMatch = label.match(
    /^(.*?)(?:\s+(west and east berth|east and west berth|west berth|east berth|north berth|south berth|berth no\.?\s*\d+[a-zA-Z-]*))$/i
  );

  if (berthTailMatch) {
    const terminal = berthTailMatch[1]?.trim();
    const berthTail = berthTailMatch[2]?.trim();

    if (terminal && berthTail) {
      const lowerTail = berthTail.toLowerCase();

      if (lowerTail === "west and east berth" || lowerTail === "east and west berth") {
        return {
          terminal,
          berths: ["West Berth", "East Berth"],
        };
      }

      return {
        terminal,
        berths: [berthTail.replace(/\s{2,}/g, " ").trim()],
      };
    }
  }

  const parts = label
    .split(/\s*[-/]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return null;

  return {
    terminal: parts[0],
    berths: parts.length > 1 ? [parts.slice(1).join(" / ")] : [],
  };
}

function isLikelyLocationLabel(value: string) {
  const lower = value.toLowerCase().trim();

  if (!lower) return false;

  const blockedStarts = [
    "air draft",
    "airdraft",
    "draft",
    "loa",
    "beam",
    "density",
    "water density",
    "transit time",
    "gangs",
    "production",
    "discharge rate",
    "load rate",
    "what bunkers",
    "holds inspection",
    "cleaning",
    "max",
    "mean",
    "subject to",
  ];

  if (blockedStarts.some((prefix) => lower.startsWith(prefix))) {
    return false;
  }

  return (
    /terminal|berth|wharf|wharves|dock|elevator|grain|viterra|pembina|cascadia|alliance|g3|surrey|cemex/i.test(
      value
    ) ||
    /\bLB\s*-?\s*\d{2,4}\b/i.test(value) ||
    /[-/]/.test(value)
  );
}

function cleanLocationCandidate(value: string) {
  let cleaned = value.trim();

  cleaned = cleaned.split(";")[0]?.trim() ?? cleaned;

  const stopPatterns = [
    /\s+\boperational\s+hours\b.*$/i,
    /\s+\bgrain\s+loading\s+equipment\b.*$/i,
    /\s+\bloading\s+equipment\b.*$/i,
    /\s+\bcargo\s+holds?\s+survey\b.*$/i,
    /\s+\bstability\s+calculation\b.*$/i,
    /\s+\bport\s+state\s+control\b.*$/i,
    /\s+\bminimum\s+depth\b.*$/i,
    /\s+\bdepth\b.*$/i,
    /\s+\btide\s+range\b.*$/i,
    /\s+\bheight\s+of\s+tide\b.*$/i,
    /\s+\bdedicated\s+to\b.*$/i,
    /\s+\bloa\b.*$/i,
    /\s+\bmax\s*dwt\b.*$/i,
    /\s+\bdwt\b.*$/i,
    /\s+\bair\s*draft\b.*$/i,
    /\s+\bdraft\b.*$/i,
    /\s+\bdensity\b.*$/i,
    /\s+\bgangs?\b.*$/i,
    /\s+\bload\s*rate\b.*$/i,
    /\s+\bdischarge\s*rate\b.*$/i,
    /\s+\bproduction\b.*$/i,
    /\s+\btransit\b.*$/i,
    /\s+\bsulphur\b.*$/i,
    /\s+\bcleaning\b.*$/i,
    /\s+\bbunker(?:ing)?\b.*$/i,
  ];

  for (const pattern of stopPatterns) {
    cleaned = cleaned.replace(pattern, "");
  }

  cleaned = cleaned
    .replace(/\s{2,}/g, " ")
    .replace(/\s*[-/]\s*$/g, "")
    .trim();

  return cleaned;
}

function isOperationalPseudoLocation(value: string) {
  const lower = value.toLowerCase().trim();
  if (!lower) return true;

  return /air draft|aircraft|cargo holds survey|stability calculation|port state control|grain loading equipment|operational hours|minimum depth|height of tide|tide range|bunker fuel sulphur|bunker fuel sulfur|fuel sulphur|fuel sulfur|where bunkering|where the bunkering ops take place|transit time|under keel clearance|water density|load rate|discharge rate|maximum beam|maximum length|max draft|at zero tide|cleaning permitted|draft along side|pipes\s*\d|based on 1 gang|-\s*sulphur$|-\s*sulfur$/i.test(
    lower
  );
}

function extractLocationFromNote(value: string) {
  const trimmed = value.trim();

  const lbMatch = trimmed.match(/\bLB\s*-?\s*(\d{2,4})\b/i);
  if (lbMatch) return `LB${lbMatch[1]}`;

  const berthOperatorMatch = trimmed.match(/\bberth\s*(\d+[a-zA-Z-]*)\s+([a-zA-Z][a-zA-Z&()./\-\s]{1,40})$/i);
  if (berthOperatorMatch) {
    const berthNumber = berthOperatorMatch[1].trim();
    const operator = berthOperatorMatch[2]
      .replace(/\b(cement|clinker|grain|coal|petcoke|soda ash)\b.*$/i, "")
      .trim();

    return operator ? `${operator} / Berth ${berthNumber}` : `Berth ${berthNumber}`;
  }

  const atMatch = trimmed.match(
    /\b(?:at|for|alongside|loading at|discharge at|discharging at|restriction at|limit at|company for)\s+(.+)$/i
  );
  if (atMatch) {
    let location = atMatch[1].trim();
    location = location
      .replace(/^terminal\s+/i, "")
      .replace(/\b(?:port|harbor|harbour)\b.*$/i, "")
      .replace(/\b(?:approximate|approx)\b.*$/i, "")
      .trim();

    const lbTailMatch = location.match(/^LB\s*-?\s*(\d{2,4})$/i);
    if (lbTailMatch) return `LB${lbTailMatch[1]}`;

    return location;
  }

  return trimmed;
}

function extractLocationFromRawSnippet(value: string) {
  const trimmed = value.trim();

  const lbMatch = trimmed.match(/^LB\s*-?\s*(\d{2,4})\b/i);
  if (lbMatch) return `LB${lbMatch[1]}`;

  const berthOperatorMatch = trimmed.match(/^Berth\s*(\d+[a-zA-Z-]*)\s*-\s*([^-]+?)(?:\s*-\s*.+)?$/i);
  if (berthOperatorMatch) {
    const berthNumber = berthOperatorMatch[1].trim();
    const operator = berthOperatorMatch[2].trim();
    return operator ? `${operator} / Berth ${berthNumber}` : `Berth ${berthNumber}`;
  }

  return trimmed;
}

function extractLocationHint(fact: FactLike, portName: string) {
  const candidates = [
    fact.locationLabel,
    fact.notes ? extractLocationFromNote(fact.notes) : null,
    fact.rawSnippet ? extractLocationFromRawSnippet(fact.rawSnippet) : null,
    fact.notes,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.trim().toLowerCase() === portName.trim().toLowerCase()) continue;

    const cleanedCandidate = cleanLocationCandidate(candidate);
    if (!isLikelyLocationLabel(cleanedCandidate)) continue;
    if (isOperationalPseudoLocation(cleanedCandidate)) continue;

    const parsed = splitLocationLabel(cleanedCandidate);
    if (parsed?.terminal) return parsed;
  }

  return null;
}

export function deriveLocationStructure(args: {
  portName: string;
  facts: FactLike[];
  hasStructuredLocations: boolean;
}) {
  if (args.hasStructuredLocations) return [] as DerivedLocationNode[];

  const terminals = new Map<string, DerivedLocationNode>();

  for (const fact of args.facts) {
    const parsed = extractLocationHint(fact, args.portName);
    if (!parsed?.terminal) continue;

    const terminalKey = canonicalizeLocationKey(parsed.terminal);
    if (!terminalKey) continue;

    if (!terminals.has(terminalKey)) {
      terminals.set(terminalKey, {
        id: `derived-${terminalKey}`,
        name: parsed.terminal,
        berths: [],
        derived: true,
      });
    }

    for (const berthName of parsed.berths) {
      const berthKey = canonicalizeLocationKey(berthName);
      if (!berthKey) continue;

      const terminal = terminals.get(terminalKey)!;
      if (!terminal.berths.some((berth) => berth.id === `${terminalKey}-${berthKey}`)) {
        terminal.berths.push({
          id: `${terminalKey}-${berthKey}`,
          name: berthName,
        });
      }
    }
  }

  return Array.from(terminals.values()).sort((a, b) => a.name.localeCompare(b.name));
}
