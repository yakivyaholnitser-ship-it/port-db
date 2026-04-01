import { NextRequest, NextResponse } from "next/server";
import { PortFactScope } from "@prisma/client";
import OpenAI from "openai";
import { prisma } from "@/lib/prisma";
import { getDatabaseUnavailableMessage, getSchemaMismatchMessage } from "@/lib/db-errors";
import { buildOperationalView } from "@/lib/operational-view";
import { conditionTagsFromParsed, parseOperationalConditions } from "@/lib/condition-parsing";
import { inferCapabilities } from "@/lib/capability-inference";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const systemPrompt = `
You are "Port Assistant" for dry bulk and general cargo operations.

Rules:
- Always distinguish port-level, terminal-level, and berth-level information.
- Never merge berth data into terminal or port data unless the user explicitly asks for a broader summary.
- When the DB contains multiple different values for the same category at the same scope/location, explicitly call it a conflict or multi-observation set.
- Do not force a conservative recommendation unless the user explicitly asks for your operational recommendation.
- Draft and density/salinity are linked. If draft values come with different density conditions, explain that clearly instead of flattening them into one number.
- Always cite source name and date for operational facts.
- If data is missing, say so clearly.
- You may make controlled operational inferences when the DB strongly indicates a handling capability. Clearly label it as an inferred capability, not as an explicit raw fact.
- Example: grain elevator / grain loader / grain spout / grain terminal wording is strong evidence that a terminal is grain-capable, even if the raw fact does not literally say "cargo = grain".
- Freight markets and weather routing are outside scope.
`.trim();

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "date unknown";
  return new Date(d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function scopeLabel(
  portName: string,
  scope: PortFactScope,
  terminalName: string | null | undefined,
  berthName: string | null | undefined
): string {
  if (scope === PortFactScope.BERTH) {
    return [portName, terminalName, berthName].filter(Boolean).join(" > ");
  }
  if (scope === PortFactScope.TERMINAL) {
    return [portName, terminalName].filter(Boolean).join(" > ");
  }
  return portName;
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
    if (!body || !Array.isArray(body.messages) || !body.messages.length) {
      return NextResponse.json(
        { error: "Missing required field 'messages' in request body." },
        { status: 400 }
      );
    }

    const incomingMessages: { role: "user" | "assistant"; content: string }[] =
      body.messages;

    const ports = await prisma.port.findMany({
      include: {
        facts: {
          include: {
            sourceRecord: true,
            terminal: true,
            berth: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { name: "asc" },
      take: 100,
    });

    if (!ports.length) {
      return NextResponse.json(
        {
          answer:
            "Port Intelligence DB is currently empty. Please ingest some port info first.",
        },
        { status: 200 }
      );
    }

    const contextBlocks: string[] = [];

    for (const port of ports) {
      const portHeader = `=== PORT: ${port.name}${port.country ? ", " + port.country : ""} ===`;
      const conflictMap = new Map<string, Set<string>>();
      const resolvedFacts = buildOperationalView({
        portName: port.name,
        facts: port.facts,
      });
      const inferredCapabilities = inferCapabilities({
        portName: port.name,
        facts: port.facts,
      });

      for (const fact of port.facts) {
        const label = scopeLabel(
          port.name,
          fact.scope,
          fact.terminal?.name,
          fact.berth?.name
        );
        const key = `${label}__${fact.category.trim().toLowerCase()}`;
        const value = `${fact.value}${fact.unit ? ` ${fact.unit}` : ""}`.trim();
        if (!conflictMap.has(key)) {
          conflictMap.set(key, new Set());
        }
        conflictMap.get(key)!.add(value);
      }

      const factLines = port.facts.map((fact) => {
        const label = scopeLabel(
          port.name,
          fact.scope,
          fact.terminal?.name,
          fact.berth?.name
        );
        const key = `${label}__${fact.category.trim().toLowerCase()}`;
        const hasConflict = (conflictMap.get(key)?.size ?? 0) > 1;
        const valuePart = `${fact.value}${fact.unit ? ` ${fact.unit}` : ""}`.trim();
        const sourcePart = fact.sourceRecord.sourceName || "unknown source";
        const datePart = fmtDate(fact.sourceRecord.sourceDate ?? fact.createdAt);
        const notesPart = fact.notes ? ` (${fact.notes})` : "";
        const conflictFlag = hasConflict ? " ⚠️ CONFLICT" : "";
        const parsedConditions = parseOperationalConditions(
          fact.value,
          fact.unit,
          fact.notes
        );
        const conditionTags = conditionTagsFromParsed(parsedConditions);
        const conditionPart =
          conditionTags.length > 0 ? ` [conditions: ${conditionTags.join(", ")}]` : "";

        return `  [${fact.scope}] ${label} | ${fact.category}: ${valuePart} — ${sourcePart} (${datePart})${notesPart}${conditionPart}${conflictFlag}`;
      });

      const resolvedLines = resolvedFacts.map(
        (fact) =>
          `  [RESOLVED ${fact.scope}] ${fact.locationLabel} | ${fact.category}: ${fact.summary} | status=${fact.status} | observations=${fact.observationCount}`
      );
      const capabilityLines = inferredCapabilities.map(
        (capability) =>
          `  [INFERRED CAPABILITY ${capability.scope}] ${capability.locationLabel} | ${capability.capability} | confidence=${capability.confidence} | reason=${capability.reason} | signals=${capability.signals.join(", ")}`
      );

      contextBlocks.push([
        portHeader,
        ...capabilityLines,
        ...resolvedLines,
        ...factLines,
      ].join("\n"));
    }

    const dbContext = contextBlocks.join("\n\n");
    const systemWithContext = `${systemPrompt}\n\n=== PORT INTELLIGENCE DB ===\n\n${dbContext}`;

    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemWithContext },
        ...incomingMessages,
      ],
    });

    const rawAnswer =
      response.choices[0]?.message?.content ||
      "Sorry, I could not generate an answer.";

    return NextResponse.json({ answer: rawAnswer }, { status: 200 });
  } catch (err) {
    console.error("ASSISTANT FATAL ERROR:", err);
    const schemaMismatchMessage = getSchemaMismatchMessage(err);
    const databaseUnavailableMessage = getDatabaseUnavailableMessage(err);
    return NextResponse.json(
      {
        error:
          schemaMismatchMessage ??
          databaseUnavailableMessage ??
          "Internal server error in Port Assistant. See server logs for details.",
      },
      { status: schemaMismatchMessage || databaseUnavailableMessage ? 503 : 500 }
    );
  }
}
