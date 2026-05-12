import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { prisma } from "@/lib/prisma";
import { getDatabaseUnavailableMessage, getSchemaMismatchMessage } from "@/lib/db-errors";
import {
  canonicalizeLocationKey,
  normalizeLocationName,
  normalizePortName,
} from "@/lib/location-matching";
import {
  persistResolvedFacts,
  persistLocationMatchLogs,
  resolveLocationIntelligence,
  type ExtractedLocationFact,
} from "@/lib/location-intelligence";
import { normalizeParentChildLocationNames } from "@/lib/location-postprocessing";
import { geocodePortCoordinates } from "@/lib/geocoding";
import { normalizeBunkerFact } from "@/lib/bunker-semantics";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const systemPrompt = `You extract structured maritime intelligence from free-form port messages.

Return only one JSON object with this shape:
{
  "port": string,
  "country": string | null,
  "terminal": string | null,
  "berth": string | null,
  "lat": number | null,
  "lon": number | null,
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
- If the text explicitly states country or a strong geography hint like "USA", "United States", "Canada", "WA", "BC", or "Washington", extract the correct sovereign country.
- If terminal or berth is not stated, return null.
- If different facts refer to different terminals or berths in the same message, set terminal/berth on each fact individually.
- If the message contains a table, treat each table row as its own location context and carry that row's berth/terminal across every fact extracted from that row.
- For row labels like "YARA (South)", "YARA (North)", "West Berth", or "Commercial pier", attach every row-specific draft / DWT / LOA / beam / equipment / rate fact to that exact berth or row location, not just the parent terminal.
- If a location label lists multiple terminals/berths such as "S3/S4", "S3, S4, S7 and S8", "Berth 208 / 209 / 211", or similar, treat them as separate locations. Facts under a subsection titled "Restrictions (S3/S4)" apply to both S3 and S4 unless a more specific row overrides it.
- Use the top-level terminal/berth only when the whole message clearly refers to one single location.
- Short operational updates like "LB212 draft now 16m FW" or "LB214 max draft 12.8m SW" must still be resolved into the correct port/terminal/berth.
- Preserve compact real-world location IDs like "LB212", "LB214", "G3", "B12" when they are the actual terminal or berth label.
- If a fact says "now", "latest", "updated", or otherwise indicates a new operational update, still store it as a normal fact observation; do not treat it as replacing history.
- If a fact clearly applies to a berth, set scope to "berth".
- If a fact clearly applies to a terminal but not a berth, set scope to "terminal".
- If a fact applies to the whole port, set scope to "port".
- Do not confuse "draft survey" with draft restriction. "Draft survey", "shore scale", and cargo quantity determination belong to survey/other, not draft.
- Do not confuse WLTHC, topping height, hatch topping measurements, or grain-capacity topping limits with UKC. Those belong to hatch_height / restriction, not under-keel clearance.
- Do not store bunker fuel sulphur or bunker fuel specification as category "bunker". Bunkering place/location belongs to "bunker"; sulphur limit or fuel spec belongs to "sulphur".
- Fresh water supply, fresh water availability, or fresh water rate belongs to "fresh_water" or "cost", not "bunker".
- Valid categories include: draft, density, discharge_rate, load_rate, tide, equipment, gangs, shifts, cargo, restriction, customs, bunker, cleaning, survey, ukc, hatch_height, freeboard, trim, loa, beam, dwt, air_draft, production, sulphur, transit, distance_ps_to_anchorage, distance_ps_to_berth, cost, fresh_water, other.
- Capture operationally important details even if they do not fit a standard bucket; use category "other" when needed.
- Never drop a meaningful operational constraint or note.
- If the message contains only coordinates/location identity and no operational facts, return an empty facts array.`;

type ExtractedFact = {
  scope?: string | null;
  terminal?: string | null;
  berth?: string | null;
  category?: string | null;
  value?: string | null;
  unit?: string | null;
  notes?: string | null;
  rawSnippet?: string | null;
};

type ExtractedData = {
  port?: string | null;
  country?: string | null;
  terminal?: string | null;
  berth?: string | null;
  lat?: number | null;
  lon?: number | null;
  facts?: ExtractedFact[] | null;
};

const US_REGION_CODES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DC","DE","FL","GA","HI","IA","ID","IL","IN","KS","KY",
  "LA","MA","MD","ME","MI","MN","MO","MS","MT","NC","ND","NE","NH","NJ","NM","NV","NY","OH",
  "OK","OR","PA","RI","SC","SD","TN","TX","UT","VA","VT","WA","WI","WV","WY",
]);

const CANADA_REGION_CODES = new Set([
  "AB","BC","MB","NB","NL","NS","NT","NU","ON","PE","QC","SK","YT",
]);

const COUNTRY_ALIASES: Array<{ canonical: string; patterns: RegExp[] }> = [
  {
    canonical: "USA",
    patterns: [
      /\bunited states of america\b/i,
      /\bunited states\b/i,
      /\bu\.s\.a\.?\b/i,
      /(?:^|[,\s(])usa(?:$|[,\s)])/i,
      /\bu\.s\.\b/i,
    ],
  },
  {
    canonical: "Canada",
    patterns: [/\bcanada\b/i],
  },
  {
    canonical: "Brazil",
    patterns: [/\bbrazil\b/i, /\bbrasil\b/i],
  },
  {
    canonical: "Uruguay",
    patterns: [/\buruguay\b/i],
  },
  {
    canonical: "Argentina",
    patterns: [/\bargentina\b/i],
  },
  {
    canonical: "China",
    patterns: [/\bchina\b/i],
  },
  {
    canonical: "Australia",
    patterns: [/\baustralia\b/i],
  },
  {
    canonical: "India",
    patterns: [/\bindia\b/i],
  },
  {
    canonical: "Indonesia",
    patterns: [/\bindonesia\b/i],
  },
  {
    canonical: "Qatar",
    patterns: [/\bqatar\b/i],
  },
  {
    canonical: "Thailand",
    patterns: [/\bthailand\b/i],
  },
  {
    canonical: "South Africa",
    patterns: [/\bsouth africa\b/i],
  },
];

function normalizeCountryName(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  if (
    normalized === "usa" ||
    normalized === "u.s.a." ||
    normalized === "u.s.a" ||
    normalized === "us" ||
    normalized === "u.s." ||
    normalized === "u.s" ||
    normalized === "united states" ||
    normalized === "united states of america"
  ) {
    return "USA";
  }

  if (normalized === "canada") {
    return "Canada";
  }

  if (normalized === "brazil" || normalized === "brasil") {
    return "Brazil";
  }

  if (normalized === "uruguay") {
    return "Uruguay";
  }

  if (normalized === "argentina") {
    return "Argentina";
  }

  if (normalized === "china") {
    return "China";
  }

  if (normalized === "australia") {
    return "Australia";
  }

  if (normalized === "india") {
    return "India";
  }

  if (normalized === "indonesia") {
    return "Indonesia";
  }

  if (normalized === "qatar") {
    return "Qatar";
  }

  if (normalized === "thailand") {
    return "Thailand";
  }

  if (normalized === "south africa") {
    return "South Africa";
  }

  return value.trim();
}

function inferCountryFromText(text: string, extractedCountry: string | null): string | null {
  const explicitCountry = normalizeCountryName(extractedCountry);
  if (explicitCountry) return explicitCountry;

  for (const country of COUNTRY_ALIASES) {
    if (country.patterns.some((pattern) => pattern.test(text))) {
      return country.canonical;
    }
  }

  const regionCodeMatches = Array.from(
    text.matchAll(/(?:,\s*|\b)([A-Z]{2})(?=(?:\s*,|\s*$|\s+(?:USA|U\.S\.A\.?|United States|Canada)\b))/g)
  ).map((match) => match[1]);

  if (regionCodeMatches.some((code) => US_REGION_CODES.has(code))) {
    return "USA";
  }

  if (regionCodeMatches.some((code) => CANADA_REGION_CODES.has(code))) {
    return "Canada";
  }

  if (/\bwashington state\b/i.test(text) || /\boregon\b/i.test(text) || /\bcalifornia\b/i.test(text)) {
    return "USA";
  }

  if (/\bbritish columbia\b/i.test(text) || /\bbc,?\s+canada\b/i.test(text)) {
    return "Canada";
  }

  if (/\bsiam commercial seaport\b|\bsiam seaport\b|\blaem chabang\b|\bsriracha\b|\bchon\s*buri\b|\bchonburi\b/i.test(text)) {
    return "Thailand";
  }

  return null;
}

function chooseCountrySafePort<T extends {
  id: number;
  name: string;
  normalizedName?: string | null;
  country: string | null;
  _count?: {
    facts?: number;
    terminals?: number;
    berths?: number;
    sourceRecords?: number;
  };
}>(ports: T[], country: string | null) {
  const normalizedCountry = normalizeCountryName(country);
  if (!normalizedCountry) {
    return chooseExistingPort(ports, null);
  }

  const exactCountry = ports.filter(
    (port) => normalizeCountryName(port.country) === normalizedCountry
  );
  if (exactCountry.length > 0) {
    return chooseExistingPort(exactCountry, normalizedCountry);
  }

  const unknownCountry = ports.filter((port) => !normalizeCountryName(port.country));
  if (unknownCountry.length > 0) {
    return chooseExistingPort(unknownCountry, null);
  }

  return null;
}

function chooseExistingPort<T extends {
  id: number;
  name: string;
  normalizedName?: string | null;
  country: string | null;
  _count?: {
    facts?: number;
    terminals?: number;
    berths?: number;
    sourceRecords?: number;
  };
}>(ports: T[], country: string | null) {
  if (ports.length === 0) return null;

  const exactCountryMatch =
    country != null
      ? ports.find((port) => (port.country ?? null) === country) ?? null
      : null;

  if (exactCountryMatch) return exactCountryMatch;

  const ranked = [...ports].sort((a, b) => {
    const aCountryScore = a.country ? 1 : 0;
    const bCountryScore = b.country ? 1 : 0;
    if (aCountryScore !== bCountryScore) return bCountryScore - aCountryScore;

    const aActivity =
      (a._count?.facts ?? 0) +
      (a._count?.terminals ?? 0) +
      (a._count?.berths ?? 0) +
      (a._count?.sourceRecords ?? 0);
    const bActivity =
      (b._count?.facts ?? 0) +
      (b._count?.terminals ?? 0) +
      (b._count?.berths ?? 0) +
      (b._count?.sourceRecords ?? 0);

    if (aActivity !== bActivity) return bActivity - aActivity;
    return a.id - b.id;
  });

  return ranked[0] ?? null;
}

function choosePortByNameOverlap<T extends {
  id: number;
  name: string;
  normalizedName?: string | null;
  country: string | null;
  _count?: {
    facts?: number;
    terminals?: number;
    berths?: number;
    sourceRecords?: number;
  };
}>(ports: T[], rawPortName: string, country: string | null) {
  const rawKey = canonicalizeLocationKey(rawPortName);
  const overlapping = ports.filter((port) => {
    const nameKey = canonicalizeLocationKey(port.name);
    const normalizedKey = canonicalizeLocationKey(port.normalizedName ?? "");
    return (
      (nameKey && (rawKey.includes(nameKey) || nameKey.includes(rawKey))) ||
      (normalizedKey && (rawKey.includes(normalizedKey) || normalizedKey.includes(rawKey)))
    );
  });

  return chooseCountrySafePort(overlapping, country);
}

function inferTopLevelTerminalFromText(text: string, portName: string) {
  const escapedPortName = portName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) return null;

  const match = firstLine.match(new RegExp(`^${escapedPortName}[\\s,:-]+(.+)$`, "i"));
  if (!match?.[1]) return null;

  const remainder = match[1]
    .replace(/^[\s,.:;/-]+/, "")
    .split(
      /\b(max draft|draft along side|draft alongside|draft|density|water density|load rate|discharge rate|equipment|gangs|shifts|air draft|loa|beam|ukc|freeboard|trim|tide|cargo|restriction|restrictions)\b/i
    )[0]
    ?.trim()
    .replace(/^[,.:;/-]+|[,.:;/-]+$/g, "");

  if (!remainder) return null;
  if (remainder.length > 40) return null;

  return normalizeLocationName(remainder);
}

function inferCommonLocationName(
  facts: ExtractedFact[] | null | undefined,
  key: "terminal" | "berth"
) {
  if (!Array.isArray(facts) || facts.length === 0) return null;
  const values = facts
    .map((fact) => fact[key]?.trim())
    .filter((value): value is string => Boolean(value));

  if (values.length === 0) return null;
  const normalized = normalizeLocationName(values[0]);
  const allSame = values.every((value) => normalizeLocationName(value) === normalized);
  return allSame ? normalized : null;
}

function inferCommonScope(facts: ExtractedFact[] | null | undefined) {
  if (!Array.isArray(facts) || facts.length === 0) return null;
  const values = facts
    .map((fact) => fact.scope?.trim()?.toLowerCase())
    .filter((value): value is string => Boolean(value));

  if (values.length === 0) return null;
  return values.every((value) => value === values[0]) ? values[0] : null;
}

function promoteCommonTopLevelLocation(args: {
  extracted: ExtractedData;
  text: string;
  portName: string;
  terminalName: string | null;
  berthName: string | null;
}) {
  let terminalName = args.terminalName;
  let berthName = args.berthName;
  const commonTerminal = inferCommonLocationName(args.extracted.facts, "terminal");
  const commonBerth = inferCommonLocationName(args.extracted.facts, "berth");
  const commonScope = inferCommonScope(args.extracted.facts);

  if (!terminalName && !berthName && (commonTerminal || commonScope === "terminal" || commonScope === "berth")) {
    terminalName =
      commonTerminal ??
      inferTopLevelTerminalFromText(args.text, args.portName) ??
      terminalName;
  }

  if (!berthName && (commonBerth || commonScope === "berth")) {
    berthName = commonBerth ?? berthName;
  }

  return { terminalName, berthName };
}

function parseSourceDateInput(value: string | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const dateOnly = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeDuplicateText(value: string) {
  return value
    .toLowerCase()
    .replace(/\*\*/g, "")
    .replace(/^[\s>*-]+/gm, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function normalizeExtractedOperationalFact(fact: ExtractedFact): ExtractedLocationFact {
  const baseCategory = fact.category!.trim();
  const baseValue = fact.value!.trim();
  const baseNotes = fact.notes?.trim() || null;
  const baseRawSnippet = fact.rawSnippet?.trim() || null;
  const haystack = [baseValue, fact.unit, baseNotes, baseRawSnippet].filter(Boolean).join(" ");

  if (
    /\bfresh\s*water\b|\bfreshwater\b/i.test(haystack) &&
    !/\bwater density\b|\bdensity\b/i.test(haystack) &&
    baseCategory.toLowerCase() !== "cost"
  ) {
    return {
      scope: fact.scope ?? null,
      terminal: fact.terminal ?? null,
      berth: fact.berth ?? null,
      category: "fresh_water",
      value: baseValue,
      unit: fact.unit?.trim() || null,
      notes: baseNotes,
      rawSnippet: baseRawSnippet,
    };
  }

  if (baseCategory.toLowerCase() === "bunker") {
    const normalized = normalizeBunkerFact({
      category: baseCategory,
      value: baseValue,
      unit: fact.unit?.trim() || null,
      notes: baseNotes,
      rawSnippet: baseRawSnippet,
    });

    return {
      scope: fact.scope ?? null,
      terminal: fact.terminal ?? null,
      berth: fact.berth ?? null,
      category: normalized.category,
      value: normalized.value.trim(),
      unit: fact.unit?.trim() || null,
      notes: normalized.notes?.trim() || null,
      rawSnippet: normalized.rawSnippet?.trim() || null,
    };
  }

  return {
    scope: fact.scope ?? null,
    terminal: fact.terminal ?? null,
    berth: fact.berth ?? null,
    category: baseCategory,
    value: baseValue,
    unit: fact.unit?.trim() || null,
    notes: baseNotes,
    rawSnippet: baseRawSnippet,
  };
}

function looksLikeCompactLocationToken(value: string) {
  return /[A-Za-zА-Яа-я#]+\s*\d+|\d+\s*[A-Za-zА-Яа-я#]+/.test(value.trim());
}

function splitGroupedLocationName(value: string | null | undefined) {
  if (!value?.trim()) return [];

  const raw = value
    .trim()
    .replace(/\(([^)]*(?:\/|,|&|\band\b)[^)]*)\)/gi, " $1 ")
    .replace(/\b(?:berths?|terminals?|piers?|jetties?|wharves?|wharf|quays?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!/[\/,&]|\band\b/i.test(raw) && !/\s-\s|[A-Za-zА-Яа-я#]\d+\s*-\s*[A-Za-zА-Яа-я#]?\d+/i.test(raw)) {
    return [];
  }

  const expanded = raw.replace(
    /([A-Za-zА-Яа-я#]+\s*\d+|\d+\s*[A-Za-zА-Яа-я#]+)\s*-\s*([A-Za-zА-Яа-я#]+\s*\d+|\d+\s*[A-Za-zА-Яа-я#]+)/g,
    "$1 / $2"
  );

  const tokens = expanded
    .split(/\s*(?:\/|,|&|\band\b)\s*/i)
    .map((token) => normalizeLocationName(token.replace(/^[()]+|[()]+$/g, "").trim()))
    .filter(Boolean);

  const uniqueTokens = Array.from(new Set(tokens));
  if (uniqueTokens.length < 2) return [];

  return uniqueTokens;
}

function normalizeGroupedLocationFacts(
  facts: ExtractedLocationFact[],
  groupedTopLevelLocationNames: string[] = []
) {
  const normalizedFacts: ExtractedLocationFact[] = [];
  const groupedTopLevelKeys = new Set(
    groupedTopLevelLocationNames.map((name) => canonicalizeLocationKey(name)).filter(Boolean)
  );

  for (const fact of facts) {
    const factTerminalKey = fact.terminal ? canonicalizeLocationKey(fact.terminal) : null;
    const factBerthKey = fact.berth ? canonicalizeLocationKey(fact.berth) : null;

    if (
      fact.terminal &&
      !fact.berth &&
      factTerminalKey &&
      groupedTopLevelKeys.has(factTerminalKey) &&
      looksLikeCompactLocationToken(fact.terminal)
    ) {
      normalizedFacts.push({
        ...fact,
        scope: "berth",
        terminal: null,
        berth: fact.terminal,
        notes: [fact.notes, `Treated grouped top-level location "${fact.terminal}" as a berth/location unit.`]
          .filter(Boolean)
          .join(" "),
      });
      continue;
    }

    if (
      fact.berth &&
      factBerthKey &&
      groupedTopLevelKeys.has(factBerthKey) &&
      fact.terminal &&
      factTerminalKey &&
      groupedTopLevelKeys.has(factTerminalKey)
    ) {
      normalizedFacts.push({
        ...fact,
        scope: "berth",
        terminal: null,
        berth: fact.berth,
        notes: [fact.notes, `Treated grouped top-level location "${fact.berth}" as a berth/location unit.`]
          .filter(Boolean)
          .join(" "),
      });
      continue;
    }

    const berthGroup = splitGroupedLocationName(fact.berth);
    if (berthGroup.length >= 2) {
      normalizedFacts.push(
        ...berthGroup.map((berth) => ({
          ...fact,
          scope: "berth",
          berth,
          notes: [fact.notes, `Applies to grouped berth set: ${fact.berth}`].filter(Boolean).join(" "),
        }))
      );
      continue;
    }

    const terminalGroup = splitGroupedLocationName(fact.terminal);
    const category = fact.category.trim().toLowerCase();
    const haystack = [fact.value, fact.notes, fact.rawSnippet].filter(Boolean).join(" ");
    const berthLikeGroup =
      terminalGroup.length >= 2 &&
      (fact.scope?.toLowerCase() === "berth" ||
        /\bberths?|piers?|jetties?|wharves?|wharf|quays?\b/i.test(haystack) ||
        terminalGroup.every(looksLikeCompactLocationToken));

    if (terminalGroup.length >= 2 && berthLikeGroup) {
      normalizedFacts.push(
        ...terminalGroup.map((berth) => ({
          ...fact,
          scope: "berth",
          terminal: null,
          berth,
          notes: [fact.notes, `Applies to grouped location set: ${fact.terminal}`].filter(Boolean).join(" "),
        }))
      );
      continue;
    }

    if (terminalGroup.length >= 2 && fact.scope?.toLowerCase() === "terminal") {
      normalizedFacts.push(
        ...terminalGroup.map((terminal) => ({
          ...fact,
          scope: "terminal",
          terminal,
          berth: null,
          notes: [fact.notes, `Applies to grouped terminal set: ${fact.terminal}`].filter(Boolean).join(" "),
        }))
      );
      continue;
    }

    if (terminalGroup.length >= 2 && ["draft", "density", "loa", "beam", "dwt", "air_draft", "restriction"].includes(category)) {
      normalizedFacts.push(
        ...terminalGroup.map((berth) => ({
          ...fact,
          scope: "berth",
          terminal: null,
          berth,
          notes: [fact.notes, `Applies to grouped location set: ${fact.terminal}`].filter(Boolean).join(" "),
        }))
      );
      continue;
    }

    normalizedFacts.push(fact);
  }

  return normalizedFacts;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { text, source, sourceDate } = body as {
      text?: string;
      source?: string;
      sourceDate?: string;
    };

    if (!text?.trim()) {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    const extracted = JSON.parse(raw) as ExtractedData;

    const portName = normalizePortName(extracted.port ?? "");
    const portKey = canonicalizeLocationKey(portName);
    const country = inferCountryFromText(text, extracted.country?.trim() || null);
    let terminalName = extracted.terminal?.trim()
      ? normalizeLocationName(extracted.terminal)
      : null;
    let berthName = extracted.berth?.trim()
      ? normalizeLocationName(extracted.berth)
      : null;

    const promotedTopLevelLocation = promoteCommonTopLevelLocation({
      extracted,
      text,
      portName,
      terminalName,
      berthName,
    });
    terminalName = promotedTopLevelLocation.terminalName;
    berthName = promotedTopLevelLocation.berthName;

    const groupedTopLevelLocationNames = [
      ...splitGroupedLocationName(terminalName),
      ...splitGroupedLocationName(berthName),
    ];

    if (!berthName && splitGroupedLocationName(terminalName).length >= 2) {
      terminalName = null;
    }
    if (splitGroupedLocationName(berthName).length >= 2) {
      berthName = null;
    }

    if (!portName) {
      return NextResponse.json({ error: "Could not extract port name" }, { status: 422 });
    }

    const exactPortCandidates = await prisma.port.findMany({
      where: {
        OR: [
          { normalizedName: portKey },
          { normalizedName: portName },
          { name: { equals: portName, mode: "insensitive" } },
        ],
      },
      include: {
        _count: {
          select: {
            facts: true,
            terminals: true,
            berths: true,
            sourceRecords: true,
          },
        },
      },
      orderBy: { id: "asc" },
    });

    let overlapPortCandidates = exactPortCandidates;

    if (overlapPortCandidates.length === 0) {
      const firstToken = portName.split(/\s+/)[0]?.trim() ?? portName;
      overlapPortCandidates = await prisma.port.findMany({
        where: {
          OR: [
            { name: { contains: firstToken, mode: "insensitive" } },
            { normalizedName: { contains: canonicalizeLocationKey(firstToken) } },
          ],
        },
        include: {
          _count: {
            select: {
              facts: true,
              terminals: true,
              berths: true,
              sourceRecords: true,
            },
          },
        },
        orderBy: { id: "asc" },
      });
    }

    const existingPort =
      chooseCountrySafePort(exactPortCandidates, country) ??
      choosePortByNameOverlap(overlapPortCandidates, portName, country) ??
      chooseCountrySafePort(overlapPortCandidates, country);

    const extractedLat = extracted.lat ?? null;
    const extractedLon = extracted.lon ?? null;
    const geocodedCoordinates =
      extractedLat == null || extractedLon == null
        ? await geocodePortCoordinates({ portName, country, contextText: text })
        : null;
    const resolvedLat = extractedLat ?? geocodedCoordinates?.lat ?? null;
    const resolvedLon = extractedLon ?? geocodedCoordinates?.lon ?? null;
    const resolvedCountry = country ?? normalizeCountryName(geocodedCoordinates?.country);

    const port = existingPort
      ? await prisma.port.update({
          where: { id: existingPort.id },
          data: {
            name: existingPort.name || portName,
            normalizedName: portKey,
            country: existingPort.country ?? resolvedCountry,
            lat: existingPort.lat ?? resolvedLat,
            lon: existingPort.lon ?? resolvedLon,
          },
        })
      : await prisma.port.create({
          data: {
            name: portName,
            normalizedName: portKey,
            country: resolvedCountry,
            lat: resolvedLat,
            lon: resolvedLon,
          },
        });

    if (!terminalName && existingPort) {
      const rawPortKey = canonicalizeLocationKey(portName);
      const existingPortKey = canonicalizeLocationKey(existingPort.name);

      if (
        rawPortKey &&
        existingPortKey &&
        rawPortKey.startsWith(existingPortKey) &&
        rawPortKey.length > existingPortKey.length
      ) {
        const remainder = portName.slice(existingPort.name.length).trim();
        if (remainder) {
          terminalName = normalizeLocationName(remainder);
        }
      }
    }

    const parsedSourceDate = parseSourceDateInput(sourceDate);

    const facts: ExtractedLocationFact[] = Array.isArray(extracted.facts)
      ? extracted.facts
          .filter(
            (fact): fact is ExtractedFact =>
              Boolean(fact?.category?.trim()) && Boolean(fact?.value?.trim())
          )
          .map((fact) => normalizeExtractedOperationalFact(fact))
      : [];
    const locationNormalizedFacts = normalizeGroupedLocationFacts(facts, groupedTopLevelLocationNames);

    const locationResolution = await resolveLocationIntelligence({
      db: prisma,
      client,
      port,
      topLevelTerminalName: terminalName,
      topLevelBerthName: berthName,
      facts: locationNormalizedFacts,
      lat: resolvedLat,
      lon: resolvedLon,
    });

    const candidateSourceRecords = await prisma.sourceRecord.findMany({
      where: {
        portId: port.id,
        sourceName: source?.trim() || null,
        sourceDate: parsedSourceDate,
      },
      include: {
        facts: true,
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    const incomingTextSignature = normalizeDuplicateText(text);

    const duplicateSourceRecord = candidateSourceRecords.find((record) => {
      const existingTextSignature = normalizeDuplicateText(record.rawText);
      return existingTextSignature === incomingTextSignature;
    });

    if (duplicateSourceRecord) {
      return NextResponse.json({
        port: { id: port.id, name: port.name, country: port.country },
        terminal: locationResolution.defaultTerminal
          ? { id: locationResolution.defaultTerminal.id, name: locationResolution.defaultTerminal.name }
          : null,
        berth: locationResolution.defaultBerth
          ? { id: locationResolution.defaultBerth.id, name: locationResolution.defaultBerth.name }
          : null,
        factsAdded: 0,
        duplicateOfSourceRecordId: duplicateSourceRecord.id,
      });
    }

    const sourceRecord = await prisma.sourceRecord.create({
      data: {
        sourceName: source?.trim() || null,
        sourceDate: parsedSourceDate,
        rawText: text,
        portId: port.id,
        terminalId:
          locationResolution.distinctTerminalIds.length === 1
            ? locationResolution.distinctTerminalIds[0]
            : (locationResolution.defaultTerminal?.id ?? null),
        berthId:
          locationResolution.distinctBerthIds.length === 1
            ? locationResolution.distinctBerthIds[0]
            : (locationResolution.defaultBerth?.id ?? null),
      },
    });

    await persistLocationMatchLogs({
      db: prisma,
      portId: port.id,
      sourceRecordId: sourceRecord.id,
      logs: locationResolution.logs,
    });

    await persistResolvedFacts({
      db: prisma,
      sourceRecordId: sourceRecord.id,
      factRows: locationResolution.factRows,
    });

    const touchedTerminalIds = Array.from(
      new Set(
        locationResolution.factRows
          .map((row) => row.terminalId)
          .filter((id): id is number => typeof id === "number")
      )
    );

    await normalizeParentChildLocationNames({
      db: prisma,
      portId: port.id,
      terminalIds: touchedTerminalIds,
    });

    return NextResponse.json({
      port: { id: port.id, name: port.name, country: port.country },
      terminal: locationResolution.defaultTerminal
        ? { id: locationResolution.defaultTerminal.id, name: locationResolution.defaultTerminal.name }
        : null,
      berth: locationResolution.defaultBerth
        ? { id: locationResolution.defaultBerth.id, name: locationResolution.defaultBerth.name }
        : null,
      factsAdded: locationNormalizedFacts.length,
    });
  } catch (err) {
    console.error("ingest-v2 error:", err);
    const schemaMismatchMessage = getSchemaMismatchMessage(err);
    const databaseUnavailableMessage = getDatabaseUnavailableMessage(err);
    return NextResponse.json(
      {
        error:
          schemaMismatchMessage ??
          databaseUnavailableMessage ??
          (process.env.NODE_ENV !== "production" && err instanceof Error
            ? err.message
            : "Internal server error"),
      },
      { status: schemaMismatchMessage || databaseUnavailableMessage ? 503 : 500 }
    );
  }
}
