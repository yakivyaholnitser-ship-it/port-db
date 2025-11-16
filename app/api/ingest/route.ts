import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Тип данных, которые мы ожидаем от ИИ / fallback-парсера
type ParsedPortPayload = {
  port?: string | null;
  country?: string | null;
  terminal?: string | null;
  operation?: string | null; // "Load" | "Discharge" | "Bunker" | ...
  cargo?: string | null;
  stowFactor?: string | null;
  quantityInfo?: string | null;

  waterDensity?: string | null;

  maxDraftMeters?: string | number | null;
  maxDraftNotes?: string | null;

  loaMeters?: string | number | null;
  beamMeters?: string | number | null;
  maxDwtMt?: string | number | null;
  airDraftMeters?: string | number | null;
  minFreeboardMeters?: string | number | null;

  loadRatePerDayMt?: string | number | null;
  dischargeRatePerDayMt?: string | number | null;

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
};

// Хелпер: любое значение → строка или null (под Prisma-схему)
function toStr(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value.toString();
  }
  // на всякий случай — превратим в строку всё остальное
  return String(value);
}

// Очень простой fallback-парсер, если OpenAI не сработал (или квота, или ошибка)
function fallbackParse(text: string): ParsedPortPayload {
  const lower = text.toLowerCase();

  let terminal: string | null = null;
  const termMatch = text.match(/\*\*Terminal:\*\*\s*([A-Za-z0-9\- ]+)/);
  if (termMatch) terminal = termMatch[1].trim();

  let cargo: string | null = null;
  let stowFactor: string | null = null;
  const cargoMatch = text.match(/\*\*Cargo\s*&\s*SF:\*\*\s*([^;]+);?\s*\*{0,2}\s*Quantity/i);
  if (cargoMatch) {
    const raw = cargoMatch[1].trim(); // напр. "Soda Ash - 1 CBM/MT"
    const parts = raw.split("-");
    cargo = parts[0].trim();
    if (parts[1]) stowFactor = parts[1].trim();
  }

  let maxDraftMeters: string | null = null;
  const draftMatch = text.match(/Max Draft:\s*Draft:\s*[^0-9]*(\d+[.,]?\d*)\s*m/i);
  if (draftMatch) {
    maxDraftMeters = draftMatch[1].replace(",", ".");
  }

  let loadRatePerDayMt: string | null = null;
  const rateMatch = text.match(/Per day:\s*abt\s*([\d,]+)\s*MT\/shift/i);
  if (rateMatch) {
    loadRatePerDayMt = rateMatch[1].replace(/,/g, "");
  }

  const waterDensityMatch = text.match(/Water Density:\s*([0-9.]+)/i);
  const waterDensity = waterDensityMatch ? waterDensityMatch[1] : null;

  const pilotageMatch = text.match(/\*\*Pilotage:\*\*\s*([^\n]+)/i);
  const costPilotage = pilotageMatch ? pilotageMatch[1].trim() : null;

  const dockageMatch = text.match(/\*\*Dockage:\*\*\s*([^\n]+)/i);
  const costDockage = dockageMatch ? dockageMatch[1].trim() : null;

  const totalMatch = text.match(/\*\*Total:\*\*\s*([^\n]+)/i);
  const costTotalEstimate = totalMatch ? totalMatch[1].trim() : null;

  let operation: string | null = null;
  if (lower.includes("***loading***") || lower.includes("loading")) {
    operation = "Load";
  } else if (lower.includes("***discharging***") || lower.includes("discharg")) {
    operation = "Discharge";
  } else if (lower.includes("bunkering") || lower.includes("bunker")) {
    operation = "Bunker";
  }

  return {
    port: null, // ИИ обычно определяет лучше — здесь оставим null
    country: null,
    terminal,
    operation,
    cargo,
    stowFactor,
    quantityInfo: null,
    waterDensity,
    maxDraftMeters,
    maxDraftNotes: null,
    loaMeters: null,
    beamMeters: null,
    maxDwtMt: null,
    airDraftMeters: null,
    minFreeboardMeters: null,
    loadRatePerDayMt,
    dischargeRatePerDayMt: null,
    agents: null,
    costDockage,
    costPilotage,
    costTowage: null,
    costTotalEstimate,
    bunkeringNotes: null,
    cleaningNotes: null,
    transitPsNotes: null,
    sulphurLimit: null,
    specialRestrictions: null,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { text } = body ?? {};

    if (!text || typeof text !== "string" || !text.trim()) {
      return NextResponse.json(
        { error: "Missing required field: text" },
        { status: 400 }
      );
    }

    let parsed: ParsedPortPayload | null = null;

    // Пытаемся сначала через OpenAI (красивый JSON)
    try {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("No OPENAI_API_KEY provided");
      }

      const prompt = `
You are a strict JSON parser for port operational notes.

User will give you raw text like:

- LB 212 - Soda Ash
    - **Terminal:** LB212
    - **Agents:**
    - **Cost:**
        - **Dockage:** Dockage Charges based on the LOA | LOA Slab Considered: From 165-180 mt | Basis: Fixed Cost USD 1512 per day x 3.25 Days = USD 4914.00
        - **Pilotage:** abt $4k - 6$k
        - **Total:** abt $25k - $40k

and so on.

You MUST respond with ONLY one JSON object with the following fields:

{
  "port": "string or null",
  "country": "string or null",
  "terminal": "string or null",
  "operation": "Load | Discharge | Bunker | null",
  "cargo": "string or null",
  "stowFactor": "string or null",
  "quantityInfo": "string or null",

  "waterDensity": "string or null",

  "maxDraftMeters": "string or number or null",
  "maxDraftNotes": "string or null",

  "loaMeters": "string or number or null",
  "beamMeters": "string or number or null",
  "maxDwtMt": "string or number or null",
  "airDraftMeters": "string or number or null",
  "minFreeboardMeters": "string or number or null",

  "loadRatePerDayMt": "string or number or null",
  "dischargeRatePerDayMt": "string or number or null",

  "agents": "string or null",

  "costDockage": "string or null",
  "costPilotage": "string or null",
  "costTowage": "string or null",
  "costTotalEstimate": "string or null",

  "bunkeringNotes": "string or null",
  "cleaningNotes": "string or null",
  "transitPsNotes": "string or null",
  "sulphurLimit": "string or null",

  "specialRestrictions": "string or null"
}

Return ONLY valid JSON. No markdown, no comments, no explanation.
`;

      const completion = await client.chat.completions.create({
        model: "gpt-4.1-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: prompt,
          },
          {
            role: "user",
            content: text,
          },
        ],
      });

      const content = completion.choices[0]?.message?.content;
      if (!content) {
        throw new Error("Empty response from OpenAI");
      }

      parsed = JSON.parse(content) as ParsedPortPayload;
    } catch (err) {
      console.error("OpenAI parse failed, using fallback. Error:", err);
      parsed = fallbackParse(text);
    }

    // Нормализуем все поля под Prisma-схему (строки/nullable)
    const entry = await prisma.portEntry.create({
      data: {
        port: parsed.port ?? "UNKNOWN_PORT",
        country: parsed.country ?? null,
        terminal: parsed.terminal ?? "UNKNOWN_TERMINAL",
        operation: parsed.operation ?? "UNKNOWN_OPERATION",

        cargo: toStr(parsed.cargo),
        stowFactor: toStr(parsed.stowFactor),
        quantityInfo: toStr(parsed.quantityInfo),

        waterDensity: toStr(parsed.waterDensity),

        maxDraftMeters: toStr(parsed.maxDraftMeters),
        maxDraftNotes: toStr(parsed.maxDraftNotes),

        loaMeters: toStr(parsed.loaMeters),
        beamMeters: toStr(parsed.beamMeters),
        maxDwtMt: toStr(parsed.maxDwtMt),
        airDraftMeters: toStr(parsed.airDraftMeters),
        minFreeboardMeters: toStr(parsed.minFreeboardMeters),

        loadRatePerDayMt: toStr(parsed.loadRatePerDayMt),
        dischargeRatePerDayMt: toStr(parsed.dischargeRatePerDayMt),

        agents: toStr(parsed.agents),

        costDockage: toStr(parsed.costDockage),
        costPilotage: toStr(parsed.costPilotage),
        costTowage: toStr(parsed.costTowage),
        costTotalEstimate: toStr(parsed.costTotalEstimate),

        bunkeringNotes: toStr(parsed.bunkeringNotes),
        cleaningNotes: toStr(parsed.cleaningNotes),
        transitPsNotes: toStr(parsed.transitPsNotes),
        sulphurLimit: toStr(parsed.sulphurLimit),

        specialRestrictions: toStr(parsed.specialRestrictions),

        rawText: text,
      },
    });

    return NextResponse.json({ success: true, entry }, { status: 200 });
  } catch (err) {
    console.error("INGEST FATAL ERROR:", err);
    return NextResponse.json(
      { error: "Internal server error while ingesting" },
      { status: 500 }
    );
  }
}