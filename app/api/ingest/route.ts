import { NextResponse } from "next/server";
import OpenAI from "openai";
import { prisma } from "@/lib/prisma";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Страхуемся от undefined / слишком длинных строк
function safeString(val: unknown): string | null {
  if (val === undefined || val === null) return null;
  return String(val).slice(0, 191);
}

export async function POST(req: Request) {
  try {
    // Поддерживаем оба варианта:
    // 1) фронтенд отправляет JSON { text: "..." }
    // 2) Make/HTTP отправляет просто "сырой" текст
    const rawBody = await req.text();
    let body: any;

    try {
      body = JSON.parse(rawBody);
    } catch {
      // Если это не JSON — считаем, что это уже чистый текст
      body = { text: rawBody };
    }

    const text =
      typeof body.text === "string" ? body.text.trim() : "";

    if (!text) {
      console.error("INGEST: missing required field 'text' in body", body);
      return NextResponse.json(
        {
          success: false,
          error:
            "Missing required fields: text, port, terminal, operation are mandatory.",
        },
        { status: 400 }
      );
    }

    const systemPrompt = `
Ты — помощник по портовым данным. На входе ты получаешь сырую текстовую порт-инфу
(терминал, ограничения, ставки, груз, плотность воды, осадки, агенты, бункера, очистка и т.п.).

Твоя задача — вернуть ЧИСТЫЙ JSON (БЕЗ комментариев, БЕЗ лишнего текста),
строго в следующей структуре:

{
  "port": "Long Beach",
  "country": "USA",
  "terminal": "LB214",
  "operation": "Load",          // "Load" | "Discharge" | "Bunker"
  "cargo": "Green Delayed Petcoke",
  "stowFactor": "43/44",
  "quantityInfo": "обычно 30-35k MT",

  "waterDensity": "1.025",
  "maxDraftMeters": "12.20",    // ВСЕ ЧИСЛА — ТОЖЕ СТРОКА
  "maxDraftNotes": "40 ft MLLW",
  "loaMeters": "225",
  "beamMeters": "32.3",
  "maxDwtMt": "72000",
  "airDraftMeters": "66",
  "minFreeboardMeters": "4.88",

  "loadRatePerDayMt": "24000",
  "dischargeRatePerDayMt": "9000",

  "agents": "Transmarine",
  "costDockage": "Dockage Charges based on LOA ...",
  "costPilotage": "abt 4k-6k",
  "costTowage": "if known, иначе null",
  "costTotalEstimate": "abt 25k - 40k",

  "bunkeringNotes": "Inner Anchorage or berth; <0.1% sulphur",
  "cleaningNotes": "Cleaning only at anchorage",
  "transitPsNotes": "Transit time 1–2 hours from pilot station",
  "sulphurLimit": "<0.1% sulphur",

  "specialRestrictions": "min 2000 MT remaining in any hold"
}

ОБЯЗАТЕЛЬНЫЕ поля: port, terminal, operation.
Если каких-то данных в тексте нет — ставь null.

ВСЕ численные значения (осадка, LOA, beam, DWT, суточные нормы и т.д.)
ВОЗВРАЩАЙ СТРОКАМИ, НЕ ЧИСЛАМИ.
`;

    // ⚠️ Возвращаемся на chat.completions с JSON-форматом
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      console.error("Empty content from OpenAI:", completion);
      return NextResponse.json(
        {
          success: false,
          error:
            "Модель вернула пустой ответ. Попробуй ещё раз с другим текстом.",
        },
        { status: 500 }
      );
    }

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      console.error("JSON parse error from AI:", e, content);
      return NextResponse.json(
        {
          success: false,
          error:
            "Не удалось разобрать JSON от модели. Попробуй ещё раз или сократи текст.",
        },
        { status: 500 }
      );
    }

    // Определяем operation максимально надёжно
    let operation: "Load" | "Discharge" | "Bunker" = "Load";

    if (typeof parsed.operation === "string") {
      const op = parsed.operation.toLowerCase();
      if (op.startsWith("dis")) operation = "Discharge";
      else if (op.startsWith("bun")) operation = "Bunker";
      else operation = "Load";
    } else {
      const lower = text.toLowerCase();
      if (lower.includes("discharg")) operation = "Discharge";
      else if (lower.includes("unload")) operation = "Discharge";
      else if (lower.includes("bunker")) operation = "Bunker";
    }

    // Создаём запись в БД. Все "числовые" поля — тоже строки (см. schema.prisma).
    const entry = await prisma.portEntry.create({
      data: {
        port: safeString(parsed.port) ?? "UNKNOWN_PORT",
        country: safeString(parsed.country),

        terminal: safeString(parsed.terminal) || "UNKNOWN_TERMINAL",
        operation,

        cargo: safeString(parsed.cargo),
        stowFactor: safeString(parsed.stowFactor),
        quantityInfo: safeString(parsed.quantityInfo),

        waterDensity: safeString(parsed.waterDensity),
        maxDraftMeters: safeString(parsed.maxDraftMeters),
        maxDraftNotes: safeString(parsed.maxDraftNotes),
        loaMeters: safeString(parsed.loaMeters),
        beamMeters: safeString(parsed.beamMeters),
        maxDwtMt: safeString(parsed.maxDwtMt),
        airDraftMeters: safeString(parsed.airDraftMeters),
        minFreeboardMeters: safeString(parsed.minFreeboardMeters),

        loadRatePerDayMt: safeString(parsed.loadRatePerDayMt),
        dischargeRatePerDayMt: safeString(parsed.dischargeRatePerDayMt),

        agents: safeString(parsed.agents),
        costDockage: safeString(parsed.costDockage),
        costPilotage: safeString(parsed.costPilotage),
        costTowage: safeString(parsed.costTowage),
        costTotalEstimate: safeString(parsed.costTotalEstimate),

        bunkeringNotes: safeString(parsed.bunkeringNotes),
        cleaningNotes: safeString(parsed.cleaningNotes),
        transitPsNotes: safeString(parsed.transitPsNotes),
        sulphurLimit: safeString(parsed.sulphurLimit),

        specialRestrictions: safeString(parsed.specialRestrictions),

        rawText: text,
      },
    });

    return NextResponse.json(
      {
        success: true,
        entry,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("INGEST FATAL ERROR:", err);
    return NextResponse.json(
      {
        success: false,
        error:
          "Internal server error while ingesting. Подробности смотри в логах сервера.",
      },
      { status: 500 }
    );
  }
}

// GET для загрузки последних записей
export async function GET() {
  try {
    const entries = await prisma.portEntry.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    const withCreatedAtString = entries.map((e) => ({
      ...e,
      createdAtString: e.createdAt.toISOString(),
    }));

    return NextResponse.json(
      {
        success: true,
        entries: withCreatedAtString,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("GET /api/ingest error:", err);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to load entries",
      },
      { status: 500 }
    );
  }
}