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
- Use the top-level terminal/berth only when the whole message clearly refers to one single location.
- Short operational updates like "LB212 draft now 16m FW" or "LB214 max draft 12.8m SW" must still be resolved into the correct port/terminal/berth.
- Preserve compact real-world location IDs like "LB212", "LB214", "G3", "B12" when they are the actual terminal or berth label.
- If a fact says "now", "latest", "updated", or otherwise indicates a new operational update, still store it as a normal fact observation; do not treat it as replacing history.
- If a fact clearly applies to a berth, set scope to "berth".
- If a fact clearly applies to a terminal but not a berth, set scope to "terminal".
- If a fact applies to the whole port, set scope to "port".
- Do not confuse "draft survey" with draft restriction. "Draft survey", "shore scale", and cargo quantity determination belong to survey/other, not draft.
- Do not confuse WLTHC, topping height, hatch topping measurements, or grain-capacity topping limits with UKC. Those belong to hatch_height / restriction, not under-keel clearance.
- Valid categories include: draft, density, discharge_rate, load_rate, tide, equipment, gangs, shifts, cargo, restriction, customs, bunker, cleaning, survey, ukc, hatch_height, freeboard, trim, loa, beam, dwt, air_draft, production, sulphur, transit, distance_ps_to_anchorage, distance_ps_to_berth, cost, other.
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

  return value.trim();
}

function inferCountryFromText(text: string, extractedCountry: string | null): string | null {
  const explicitCountry = normalizeCountryName(extractedCountry);
  if (explicitCountry) return explicitCountry;

  const lower = text.toLowerCase();
  if (
    /\bunited states of america\b/.test(lower) ||
    /\bunited states\b/.test(lower) ||
    /\bu\.s\.a\.?\b/.test(lower) ||
    /(?:^|[,\s(])usa(?:$|[,\s)])/i.test(text)
  ) {
    return "USA";
  }

  if (/\bcanada\b/.test(lower)) {
    return "Canada";
  }

  const regionCodeMatches = Array.from(text.matchAll(/(?:^|[,\s(])([A-Z]{2})(?:$|[,\s)])/g)).map(
    (match) => match[1]
  );

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

    const port = existingPort
      ? await prisma.port.update({
          where: { id: existingPort.id },
          data: {
            name: existingPort.name || portName,
            normalizedName: portKey,
            country: existingPort.country ?? country,
            lat: existingPort.lat ?? resolvedLat,
            lon: existingPort.lon ?? resolvedLon,
          },
        })
      : await prisma.port.create({
          data: {
            name: portName,
            normalizedName: portKey,
            country,
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
          .map((fact) => ({
            scope: fact.scope ?? null,
            terminal: fact.terminal ?? null,
            berth: fact.berth ?? null,
            category: fact.category!.trim(),
            value: fact.value!.trim(),
            unit: fact.unit?.trim() || null,
            notes: fact.notes?.trim() || null,
            rawSnippet: fact.rawSnippet?.trim() || null,
          }))
      : [];

    const locationResolution = await resolveLocationIntelligence({
      db: prisma,
      client,
      port,
      topLevelTerminalName: terminalName,
      topLevelBerthName: berthName,
      facts,
      lat: resolvedLat,
      lon: resolvedLon,
    });

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
      factsAdded: facts.length,
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
