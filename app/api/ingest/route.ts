import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { prisma } from "@/lib/prisma";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const systemPrompt = `
You are an assistant that extracts structured port/terminal information
from free-form agent messages.

PRIMARY GOAL: do NOT lose any useful information.
If you cannot confidently map something to a fixed field, you MUST put it into
the "restrictions" array or into "otherInfo". Every important bullet / line
with concrete meaning must appear somewhere in the JSON.

NORMALIZATION RULES (follow strictly):
- "port": city name only, no province, no country, no suffix like "Port". Use shortest standard name. "Vancouver" not "Vancouver, BC". "Nansha" not "Nansha Port". "Rotterdam" not "Port of Rotterdam".
- "country": full country name only. "Canada" not "CA". "China" not "CN".

Return ONLY a SINGLE VALID JSON OBJECT (no markdown, no \`\`\`).

{
  "port": string,
  "country": string | null,
  "terminal": string,
  "operation": "Load" | "Discharge" | "Bunker" | "Load/Discharge" | string,

  "lat": number | null,
  "lon": number | null,

  "cargo": string | null,
  "stowFactor": string | null,
  "quantityInfo": string | null,

  "typeOfCargoesHandled": string | null,
  "productionPerDay": string | null,
  "numberOfGangs": string | null,
  "shiftsInfo": string | null,
  "equipmentUsed": string | null,
  "shiftsPerDay": string | null,

  "waterDensity": string | null,
  "maxDraftMeters": string | null,
  "maxDraftNotes": string | null,
  "loaMeters": string | null,
  "beamMeters": string | null,
  "maxDwtMt": string | null,
  "airDraftMeters": string | null,
  "spoutAirDraft": string | null,
  "waterlineToHatchCoaming": string | null,
  "minFreeboardMeters": string | null,
  "requiredTrim": string | null,

  "loadRatePerDayMt": string | null,
  "dischargeRatePerDayMt": string | null,

  "agents": string | null,
  "costDockage": string | null,
  "costPilotage": string | null,
  "costTowage": string | null,
  "costTotalEstimate": string | null,

  "transitTimeFromPs": string | null,
  "bunkeringPlace": string | null,
  "cleaningPermitted": string | null,
  "sulphurLimit": string | null,

  "bunkeringNotes": string | null,
  "cleaningNotes": string | null,

  "specialRestrictions": string | null,
  "otherInfo": string | null,

  "restrictions": [{ "name": string, "value": string }] | null,

  "factsJson": JSON string of array of facts that don't fit other fields. Each fact: {"category": string, "value": string, "note": string | null}. Extract ANY operationally relevant info not captured elsewhere: tides, surveys, customs, crew rules, documentation, port authority rules, environmental restrictions, special procedures, berthing notes, etc. If nothing extra, return "[]".
}

COORDINATES RULES:
- If coordinates are explicitly present (including phrases like "LATITUDE NORTH", "LONGITUDE WEST", "Latitude:", "Longitude:"),
  convert to decimal degrees.
- N/E are positive; S/W are negative.
- If multiple coordinate pairs exist (anchorage), prefer PORT location line; otherwise use first/most relevant.
- If no coordinates exist, approximate from port city + country (centroid ok).
- If you cannot infer a plausible location, set lat/lon to null.

IMPORTANT:
- Do NOT wrap output in markdown fences.
- Do NOT drop useful info. If not mapped to fixed fields, put into restrictions[] or otherInfo.
- Output MUST be valid JSON.
`;

function normalizePortName(port: string): string {
  return port
    .replace(/\s*\([^)]*\)\s*$/i, "")
    .replace(/,\s*(BC|AB|ON|QC|NS|NB|MB|SK|PE|NL|NT|NU|YT)$/i, "")
    .replace(/\s+(BC|AB|ON|QC|NS|NB|MB|SK|PE|NL|NT|NU|YT)$/i, "")
    .replace(/,\s*(CA|US|CN|AU|GB|DE|FR|ES|IT|NL|BE|PL|GR|TR|AE|SG|JP|KR|IN|BR|AR|ZA)$/i, "")
    .replace(/\b(Port of|Port)\s+/i, "")
    .replace(/\s+Port$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// string-or-null
function s(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const t = value.trim();
    return t.length ? t : null;
  }
  return String(value);
}

// number-or-null (Float) for lat/lon
function n(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return null;
    const num = Number(t);
    return Number.isFinite(num) ? num : null;
  }
  return null;
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
    if (!body || typeof body.text !== "string") {
      return NextResponse.json(
        { error: "Missing required field 'text' in request body." },
        { status: 400 }
      );
    }

    const text = body.text.trim();
    if (!text) {
      return NextResponse.json({ error: "Empty text." }, { status: 400 });
    }

    const dataSource: string | null =
      typeof body.dataSource === "string" && body.dataSource.trim()
        ? body.dataSource.trim()
        : null;

    const sourceDate: Date | null =
      typeof body.sourceDate === "string" && body.sourceDate.trim()
        ? new Date(body.sourceDate.trim())
        : null;

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: `Extract structured port information and return ONLY a JSON object.\n\n${text}`,
      instructions: systemPrompt,
      text: { format: { type: "json_object" } },
    });

    const firstOutput = response.output?.[0];
    if (!firstOutput || firstOutput.type !== "message") {
      console.error("Unexpected response.output:", response.output);
      return NextResponse.json(
        { error: "Unexpected response format from OpenAI (no message output)." },
        { status: 500 }
      );
    }

    const firstContent = firstOutput.content?.[0];
    if (!firstContent || firstContent.type !== "output_text") {
      console.error("Unexpected response content:", firstOutput.content);
      return NextResponse.json(
        { error: "Unexpected response content type from OpenAI." },
        { status: 500 }
      );
    }

    const rawJson = firstContent.text;
    let parsed: any;
    try {
      parsed = JSON.parse(rawJson);
    } catch (e) {
      console.error("JSON parse error:", e, "RAW:", rawJson);
      return NextResponse.json(
        { error: "Failed to parse JSON from OpenAI response." },
        { status: 500 }
      );
    }

    if (typeof parsed.port === "string") {
      parsed.port = normalizePortName(parsed.port);
    }

    const entry = await prisma.portEntry.create({
      data: {
        port: s(parsed.port) ?? "UNKNOWN_PORT",
        country: s(parsed.country),
        terminal: s(parsed.terminal) || "UNKNOWN_TERMINAL",
        operation: s(parsed.operation) || "UNKNOWN",

        lat: n(parsed.lat),
        lon: n(parsed.lon),

        cargo: s(parsed.cargo),
        stowFactor: s(parsed.stowFactor),
        quantityInfo: s(parsed.quantityInfo),
        typeOfCargoesHandled: s(parsed.typeOfCargoesHandled),
        productionPerDay: s(parsed.productionPerDay),
        numberOfGangs: s(parsed.numberOfGangs),
        shiftsInfo: s(parsed.shiftsInfo),
        equipmentUsed: s(parsed.equipmentUsed),
        shiftsPerDay: s(parsed.shiftsPerDay),

        waterDensity: s(parsed.waterDensity),
        maxDraftMeters: s(parsed.maxDraftMeters),
        maxDraftNotes: s(parsed.maxDraftNotes),
        loaMeters: s(parsed.loaMeters),
        beamMeters: s(parsed.beamMeters),
        maxDwtMt: s(parsed.maxDwtMt),
        airDraftMeters: s(parsed.airDraftMeters),
        spoutAirDraft: s(parsed.spoutAirDraft),
        waterlineToHatchCoaming: s(parsed.waterlineToHatchCoaming),
        minFreeboardMeters: s(parsed.minFreeboardMeters),
        requiredTrim: s(parsed.requiredTrim),

        loadRatePerDayMt: s(parsed.loadRatePerDayMt),
        dischargeRatePerDayMt: s(parsed.dischargeRatePerDayMt),

        agents: s(parsed.agents),
        costDockage: s(parsed.costDockage),
        costPilotage: s(parsed.costPilotage),
        costTowage: s(parsed.costTowage),
        costTotalEstimate: s(parsed.costTotalEstimate),

        transitPsNotes: s(parsed.transitTimeFromPs),
        bunkeringPlace: s(parsed.bunkeringPlace),
        cleaningPermitted: s(parsed.cleaningPermitted),
        sulphurLimit: s(parsed.sulphurLimit),

        bunkeringNotes: s(parsed.bunkeringNotes),
        cleaningNotes: s(parsed.cleaningNotes),

        specialRestrictions: s(parsed.specialRestrictions),
        otherInfo: s(parsed.otherInfo),
        restrictionsJson: parsed.restrictions
          ? JSON.stringify(parsed.restrictions)
          : null,
        factsJson: parsed.factsJson ?? null,

        dataSource,
        sourceDate,

        rawText: text,
      },
    });

    return NextResponse.json({ entry }, { status: 200 });
  } catch (err: any) {
    console.error("INGEST FATAL ERROR:", err);
    return NextResponse.json(
      { error: "Internal server error while ingesting. See server logs." },
      { status: 500 }
    );
  }
}