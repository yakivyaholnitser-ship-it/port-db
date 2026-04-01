import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { PortFactScope } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getDatabaseUnavailableMessage, getSchemaMismatchMessage } from "@/lib/db-errors";
import { buildOperationalView } from "@/lib/operational-view";
import { deriveLocationStructure } from "@/lib/location-candidates";

function keyForConflict(fact: {
  scope: PortFactScope;
  category: string;
  terminal: { name: string } | null;
  berth: { name: string } | null;
}, portName: string) {
  const locationLabel =
    fact.scope === PortFactScope.BERTH
      ? [fact.terminal?.name, fact.berth?.name].filter(Boolean).join(" / ")
      : fact.scope === PortFactScope.TERMINAL
        ? fact.terminal?.name ?? null
        : portName;

  return `${fact.scope}__${locationLabel ?? "port"}__${fact.category}`;
}

function valueForConflict(fact: { value: string; unit: string | null }) {
  return `${fact.value}${fact.unit ? ` ${fact.unit}` : ""}`.trim();
}

function detectConflictCount(
  facts: Array<{
    scope: PortFactScope;
    category: string;
    value: string;
    unit: string | null;
    terminal: { name: string } | null;
    berth: { name: string } | null;
  }>,
  portName: string
) {
  const groups = new Map<string, Set<string>>();
  for (const fact of facts) {
    const key = keyForConflict(fact, portName);
    if (!groups.has(key)) groups.set(key, new Set<string>());
    groups.get(key)!.add(valueForConflict(fact));
  }
  return Array.from(groups.values()).filter((values) => values.size > 1).length;
}

export async function GET(req: NextRequest) {
  try {
    const portId = Number(req.nextUrl.searchParams.get("portId") || "");

    if (Number.isFinite(portId) && portId > 0) {
      const port = await prisma.port.findUnique({
        where: { id: portId },
        include: {
          facts: {
            include: {
              sourceRecord: true,
              terminal: true,
              berth: true,
            },
            orderBy: { createdAt: "asc" },
          },
          terminals: {
            include: {
              berths: true,
            },
            orderBy: { name: "asc" },
          },
          berths: {
            where: { terminalId: null },
            orderBy: { name: "asc" },
          },
        },
      });

      if (!port) {
        return NextResponse.json({ error: "Port not found." }, { status: 404 });
      }

      const resolvedFacts = buildOperationalView({
        portName: port.name,
        facts: port.facts,
      });

      const facts = port.facts.map((fact) => ({
        id: fact.id,
        createdAt: fact.createdAt,
        category: fact.category,
        value: fact.value,
        unit: fact.unit,
        notes: fact.notes,
        rawSnippet: fact.rawSnippet,
        scope: fact.scope,
        locationLabel:
          fact.scope === PortFactScope.BERTH
            ? [fact.terminal?.name, fact.berth?.name].filter(Boolean).join(" / ")
            : fact.scope === PortFactScope.TERMINAL
              ? fact.terminal?.name ?? null
              : port.name,
        source: fact.sourceRecord.sourceName,
        sourceDate: fact.sourceRecord.sourceDate,
        sourceRecordId: fact.sourceRecordId,
      }));

      const derivedTerminals = deriveLocationStructure({
        portName: port.name,
        facts,
        hasStructuredLocations: port.terminals.length > 0 || port.berths.length > 0,
      });

      return NextResponse.json({
        id: port.id,
        name: port.name,
        country: port.country,
        lat: port.lat,
        lon: port.lon,
        terminals: port.terminals.map((terminal) => ({
          id: terminal.id,
          name: terminal.name,
          berths: terminal.berths.map((berth) => ({
            id: berth.id,
            name: berth.name,
          })),
        })),
        standaloneBerths: port.berths.map((berth) => ({
          id: berth.id,
          name: berth.name,
        })),
        derivedTerminals,
        facts,
        resolvedFacts,
      });
    }

    const ports = await prisma.port.findMany({
      include: {
        _count: {
          select: {
            facts: true,
            terminals: true,
          },
        },
        berths: {
          where: { terminalId: null },
          select: { id: true },
        },
        facts: {
          select: {
            scope: true,
            category: true,
            value: true,
            unit: true,
            terminal: {
              select: { name: true },
            },
            berth: {
              select: { name: true },
            },
          },
        },
      },
      orderBy: { name: "asc" },
    });

    return NextResponse.json(
      ports.map((port) => {
        const conflictCount = detectConflictCount(port.facts, port.name);

        return {
          id: port.id,
          name: port.name,
          country: port.country,
          lat: port.lat,
          lon: port.lon,
          factsCount: port._count.facts,
          terminalsCount: port._count.terminals,
          standaloneBerthsCount: port.berths.length,
          conflictCount,
        };
      })
    );
  } catch (error) {
    console.error("PORTS V2 ERROR:", error);
    const schemaMismatchMessage = getSchemaMismatchMessage(error);
    const databaseUnavailableMessage = getDatabaseUnavailableMessage(error);
    return NextResponse.json(
      {
        error:
          schemaMismatchMessage ??
          databaseUnavailableMessage ??
          "Failed to load ports.",
      },
      { status: schemaMismatchMessage || databaseUnavailableMessage ? 503 : 500 }
    );
  }
}
