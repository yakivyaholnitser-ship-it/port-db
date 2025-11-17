import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type ParsedPortInfo = {
  port?: string;
  country?: string;
  terminal?: string;
  operation?: string; // Load / Discharge / Bunker

  cargo?: string;
  stowFactor?: string;
  quantityInfo?: string;

  waterDensity?: string;
  maxDraftMeters?: string;
  maxDraftNotes?: string;
  loaMeters?: string;
  beamMeters?: string;
  maxDwtMt?: string;
  airDraftMeters?: string;
  minFreeboardMeters?: string;

  loadRatePerDayMt?: string;
  dischargeRatePerDayMt?: string;

  agents?: string;
  costDockage?: string;
  costPilotage?: string;
  costTowage?: string;
  costTotalEstimate?: string;

  bunkeringNotes?: string;
  cleaningNotes?: string;
  transitPsNotes?: string;
  sulphurLimit?: string;

  specialRestrictions?: string;
};

async function extractTextFromRequest(req: NextRequest): Promise<string> {
  const contentType = req.headers.get("content-type") || "";

  // 1) Если пришёл JSON
  if (contentType.includes("application/json")) {
    try {
      const body = await req.json();

      // Вдруг кто-то шлёт просто строку в JSON
      if (typeof body === "string") {
        return body;
      }

      if (body && typeof body.text === "string") {
        return body.text;
      }

      // На всякий случай пробуем другие популярные ключи
      if (body && typeof body.content === "string") {
        return body.content;
      }

      console.error("INGEST: JSON без text/content поля:", body);
      return "";
    } catch (e) {
      console.error("INGEST: ошибка парсинга JSON тела:", e);
      return "";
    }
  }

  // 2) Всё остальное — читаем как сырой текст
  try {
    const text = await req.text();
    return text;
  } catch (e) {
    console.error("INGEST: ошибка чтения сырое тело:", e);
    return "";
  }
}

export async function POST(req: NextRequest) {
  try {
    const text = (await extractTextFromRequest(req)).trim();

    if (!text) {
      console.error("INGEST: пустой или некорректный text в запросе");
      return NextResponse.json(
        {
          error:
            "Missing required fields: text is mandatory and must be non-empty.",
        },
        { status: 400 }
      );
    }

    const systemPrompt = `
Ты помощник по морским портам. Получаешь большой текст (инфа от агентов по порту/терминалу).
Твоя задача — вернуть ОДИН JSON-объект строго такого вида:

{
  "port": "string (порт, город/порт, если есть)",
  "country": "string или null",
  "terminal": "string или null",
  "operation": "Load | Discharge | Bunker",

  "cargo": "string или null",
  "stowFactor": "string или null",
  "quantityInfo": "string или null",

  "waterDensity": "string или null",
  "maxDraftMeters": "string или null",
  "maxDraftNotes": "string или null",
  "loaMeters": "string или null",
  "beamMeters": "string или null",
  "maxDwtMt": "string или null",
  "airDraftMeters": "string или null",
  "minFreeboardMeters": "string или null",

  "loadRatePerDayMt": "string или null",
  "dischargeRatePerDayMt": "string или null",

  "agents": "string или null",
  "costDockage": "string или null",
  "costPilotage": "string или null",
  "costTowage": "string или null",
  "costTotalEstimate": "string или null",

  "bunkeringNotes": "string или null",
  "cleaningNotes": "string или null",
  "transitPsNotes": "string или null",
  "sulphurLimit": "string или null",

  "specialRestrictions": "string или null"
}

Только JSON, без комментариев, без пояснений, без markdown.
Если каких-то данных нет — ставь null.
`;

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: text,
      instructions: systemPrompt,
      response_format: {
        type: "json_object",
      },
    });

    const outputPart = response.output[0];
    if (outputPart.type !== "message") {
      console.error("INGEST: неожиданный формат ответа OpenAI:", response);
      return NextResponse.json(
        { error: "Unexpected model response format" },
        { status: 500 }
      );
    }

    const rawJson =
      outputPart.message.content[0]?.type === "output_text"
        ? outputPart.message.content[0].text
        : "";

    if (!rawJson) {
      console.error("INGEST: пустой текст в ответе модели:", response);
      return NextResponse.json(
        { error: "Empty model response" },
        { status: 500 }
      );
    }

    let parsed: ParsedPortInfo;
    try {
      parsed = JSON.parse(rawJson);
    } catch (e) {
      console.error("INGEST: ошибка JSON.parse ответа модели:", rawJson, e);
      return NextResponse.json(
        { error: "Failed to parse model JSON" },
        { status: 500 }
      );
    }

    if (!parsed.operation || !parsed.terminal) {
      console.error("INGEST: model did not return required fields:", parsed);
      return NextResponse.json(
        {
          error:
            "Model did not return mandatory fields (operation, terminal).",
        },
        { status: 400 }
      );
    }

    const entry = await prisma.portEntry.create({
      data: {
        port: parsed.port ?? "UNKNOWN_PORT",
        country: parsed.country ?? null,
        terminal: parsed.terminal ?? "UNKNOWN_TERMINAL",
        operation: parsed.operation ?? "UNKNOWN",

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

    return NextResponse.json({ ok: true, entry }, { status: 200 });
  } catch (err: any) {
    console.error("INGEST FATAL ERROR:", err);
    return NextResponse.json(
      {
        error: "Internal server error while ingesting. See server logs.",
      },
      { status: 500 }
    );
  }
}