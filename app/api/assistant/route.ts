import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { prisma } from "@/lib/prisma";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const systemPrompt = `
You are "Port Assistant" for dry bulk / general cargo operations.

=== CONFLICT DETECTION — HIGHEST PRIORITY ===

When the DB context contains multiple entries for the same port/terminal with DIFFERENT values for the same field, you MUST surface this as a conflict. Never silently pick one value.

Format conflicts like this:

⚠️ CONFLICTING DATA — Max Draft at Nansha Port (Cosco Terminal):
  • 13.5m Fresh Water — GAC Shipping (15 Jan 2026)
  • 13.0m Fresh Water — Sinoagent (3 Mar 2026)
→ Recommend using the most conservative value (13.0m) until confirmed by current port agents.

Apply this format for ANY field that has conflicting values across entries for the same port/terminal.

=== OTHER RULES ===
- If all sources agree on a value, just give the value and note the source(s).
- Prefer short, bullet-point answers.
- Always cite Entry #ID, source name, and date for every data point.
- If the DB has no data for the question, say: "No data in Port Intelligence DB for this."
- Highlight operational risks: draft margins, tide dependence, cleaning restrictions, survey rules.
- Freight rates, weather routing = outside scope. Say so.
`.trim();

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "date unknown";
  return new Date(d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
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

    // Fetch ALL entries so we can show all versions of conflicting data
    const entries = await prisma.portEntry.findMany({
      orderBy: { createdAt: "asc" },
      take: 500,
    });

    if (!entries.length) {
      return NextResponse.json(
        {
          answer:
            "Port Intelligence DB is currently empty. Please ingest some port / terminal info first.",
        },
        { status: 200 }
      );
    }

    // Group entries by port + terminal (both case-insensitive) so conflicts are visible side-by-side
    const grouped = new Map<string, typeof entries>();
    for (const e of entries) {
      const key = `${e.port.trim().toLowerCase()}|||${(e.terminal ?? "").trim().toLowerCase()}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(e);
    }

    const contextBlocks: string[] = [];

    for (const [, portEntries] of grouped) {
      const portName = portEntries[0].port;
      const country = portEntries[0].country;
      const terminal = portEntries[0].terminal;
      const count = portEntries.length;
      const header = `=== PORT: ${portName}${country ? ", " + country : ""} | TERMINAL: ${terminal} (${count} record${count > 1 ? "s" : ""}) ===`;

      const entryLines: string[] = [];

      for (const e of portEntries) {
        const src = e.dataSource || "Unknown source";
        const date = fmtDate(e.sourceDate ?? e.createdAt);

        const lines: string[] = [
          `  [Entry #${e.id}] ${e.terminal} | ${e.operation} | Source: ${src} | Date: ${date}`,
        ];

        // Dimensions
        const dim: string[] = [];
        if (e.waterDensity) dim.push(`WD: ${e.waterDensity}`);
        if (e.maxDraftMeters)
          dim.push(`Draft: ${e.maxDraftMeters}m${e.maxDraftNotes ? " " + e.maxDraftNotes : ""}`);
        if (e.loaMeters) dim.push(`LOA: ${e.loaMeters}m`);
        if (e.beamMeters) dim.push(`Beam: ${e.beamMeters}m`);
        if (e.maxDwtMt) dim.push(`MaxDWT: ${e.maxDwtMt}mt`);
        if (e.requiredTrim) dim.push(`Trim: ${e.requiredTrim}`);
        if (dim.length) lines.push(`    ${dim.join(" | ")}`);

        // Cargo / rates
        const cargo: string[] = [];
        if (e.cargo) cargo.push(`Cargo: ${e.cargo}`);
        if (e.typeOfCargoesHandled) cargo.push(`Types: ${e.typeOfCargoesHandled}`);
        if (e.productionPerDay) cargo.push(`Prod: ${e.productionPerDay}`);
        if (e.loadRatePerDayMt) cargo.push(`LoadRate: ${e.loadRatePerDayMt}`);
        if (e.dischargeRatePerDayMt) cargo.push(`DischRate: ${e.dischargeRatePerDayMt}`);
        if (cargo.length) lines.push(`    ${cargo.join(" | ")}`);

        // Ops
        const ops: string[] = [];
        if (e.transitPsNotes) ops.push(`Transit: ${e.transitPsNotes}`);
        if (e.bunkeringPlace) ops.push(`Bunkers: ${e.bunkeringPlace}`);
        if (e.cleaningPermitted) ops.push(`Cleaning: ${e.cleaningPermitted}`);
        if (e.sulphurLimit) ops.push(`Sulphur: ${e.sulphurLimit}`);
        if (ops.length) lines.push(`    ${ops.join(" | ")}`);

        if (e.specialRestrictions) lines.push(`    Restrictions: ${e.specialRestrictions}`);
        if (e.otherInfo) lines.push(`    Other: ${e.otherInfo}`);

        entryLines.push(lines.join("\n"));
      }

      contextBlocks.push([header, ...entryLines].join("\n"));
    }

    const dbContext = contextBlocks.join("\n\n");

    const systemWithContext = `${systemPrompt}\n\n=== PORT INTELLIGENCE DB (grouped by port + terminal) ===\n\n${dbContext}`;

    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemWithContext },
        ...incomingMessages,
      ],
    });

    const rawAnswer: string =
      response.choices[0]?.message?.content ||
      "Sorry, I could not generate an answer.";

    return NextResponse.json({ answer: rawAnswer }, { status: 200 });
  } catch (err: any) {
    console.error("ASSISTANT FATAL ERROR:", err);
    return NextResponse.json(
      { error: "Internal server error in Port Assistant. See server logs for details." },
      { status: 500 }
    );
  }
}
