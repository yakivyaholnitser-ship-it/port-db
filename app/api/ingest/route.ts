// app/api/ingest/route.ts
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { prisma } from "@/lib/prisma";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// Жёсткий системный промпт: модель всегда должна вернуть чистый JSON
const SYSTEM_PROMPT = `
You are a strict JSON parser for port / terminal operational descriptions.

You MUST respond with a single valid JSON object and NOTHING else (no markdown, no extra text).
Use exactly this shape (TypeScript-like):

interface PortEntry {
  port: string;
  country?: string | null;
  terminal: string;
  operation: "Load" | "Discharge" | "Bunker";

  cargo?: string | null;
  stowFactor?: string | null;
  quantityInfo?: string | null;

  waterDensity?: string | null;
  maxDraftMeters?: string | null;
  maxDraftNotes?: string | null;
  loaMeters?: string | null;
  beamMeters?: string | null;
  maxDwtMt?: string | null;
  airDraftMeters?: string | null;
  minFreeboardMeters?: string | null;

  loadRatePerDayMt?: string | null;
  dischargeRatePerDayMt?: string | null;

  agents?: string | null;
  costDockage?: string | null;
  costPilotage?: string | null;
  costTowage?: string | null;
  costTotalEstimate?: string | null;

  bunkeringNotes?: string | null;
  cleaningNotes?: string | null;
  transitPsNotes?: string | null;
  sulphurLimit?: string | null;

  specialRestrictions?: string | null;
}

Parsing rules:
- Decide operation: "Load", "Discharge" or "Bunker" from context.
- Keep numeric values as strings with units if present (e.g. "15.24 m", "24000 MT/day").
- If you don't know a value, use null.
- Do NOT wrap the JSON in backticks or markdown.
- Final output MUST be valid JSON, starting with { and ending with }.
`;

export async function POST(req: Request) {
  try {
    let body: unknown;

    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Body must be valid JSON with field 'text'." },
        { status: 400 },
      );
    }

    const { text } = (body ?? {}) as { text?: string };

    if (!text || typeof text !== "string" || !text.trim()) {
      return NextResponse.json(
        { error: "Missing required field 'text' (non-empty string)." },
        { status: 400 },
      );
    }

    // ⚠️ Здесь НЕТ response_format и НЕТ Responses API
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    });

    const rawContent = completion.choices[0]?.message?.content;

    if (!rawContent) {
      return NextResponse.json(
        { error: "Model returned empty content." },
        { status: 500 },
      );
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawContent);
    } catch (e) {
      console.error("INGEST JSON PARSE ERROR:", rawContent, e);
      return NextResponse.json(
        {
          error:
            "Failed to parse model JSON response. Check server logs for details.",
        },
        { status: 500 },
      );
    }

    const entry = await prisma.portEntry.create({
      data: {
        port: parsed.port ?? "UNKNOWN_PORT",
        country: parsed.country ?? null,
        terminal: parsed.terminal ?? "UNKNOWN_TERMINAL",
        operation: parsed.operation ?? "Load",

        cargo: parsed.cargo ?? null,
        stowFactor: parsed.stowFactor ?? null,
        quantityInfo: parsed.quantityInfo ?? null,

        waterDensity: parsed.waterDensity ?? null,
        maxDraftMeters: parsed.maxDraftMeters ?? null,
        maxDraftNotes: parsed.maxDraftNotes ?? null,
        loaMeters: parsed.loaMeters ?? null,
        beamMeters: parsed.beamMeters ?? null,
        maxDwtMt: parsed.maxDwtMt ?? null,
        airDraftMeters: parsed.airDraftMeters ?? null,
        minFreeboardMeters: parsed.minFreeboardMeters ?? null,

        loadRatePerDayMt: parsed.loadRatePerDayMt ?? null,
        dischargeRatePerDayMt: parsed.dischargeRatePerDayMt ?? null,

        agents: parsed.agents ?? null,
        costDockage: parsed.costDockage ?? null,
        costPilotage: parsed.costPilotage ?? null,
        costTowage: parsed.costTowage ?? null,
        costTotalEstimate: parsed.costTotalEstimate ?? null,

        bunkeringNotes: parsed.bunkeringNotes ?? null,
        cleaningNotes: parsed.cleaningNotes ?? null,
        transitPsNotes: parsed.transitPsNotes ?? null,
        sulphurLimit: parsed.sulphurLimit ?? null,

        specialRestrictions: parsed.specialRestrictions ?? null,

        rawText: text,
      },
    });

    return NextResponse.json({ ok: true, entry });
  } catch (err) {
    console.error("INGEST FATAL ERROR:", err);
    return NextResponse.json(
      { error: "Internal server error while ingesting. See server logs." },
      { status: 500 },
    );
  }
}