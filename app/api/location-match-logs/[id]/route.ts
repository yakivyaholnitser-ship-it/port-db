import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { LocationEntityType, LocationMatchMethod, LocationMatchStatus, MatchConfidence } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { canonicalizeLocationKey, normalizeLocationName } from "@/lib/location-matching";

function appendReviewReason(base: string | null, suffix: string) {
  return [base, suffix].filter(Boolean).join(" ");
}

async function confirmMatch(logId: number) {
  return prisma.$transaction(async (tx) => {
    const log = await tx.locationMatchLog.findUnique({
      where: { id: logId },
    });

    if (!log) {
      throw new Error("Location match log not found.");
    }

    return tx.locationMatchLog.update({
      where: { id: logId },
      data: {
        status: LocationMatchStatus.MATCHED,
        confidence: MatchConfidence.HIGH,
        reason: appendReviewReason(log.reason, "Review action: human confirmed this match."),
      },
    });
  });
}

async function promoteAlias(logId: number) {
  return prisma.$transaction(async (tx) => {
    const log = await tx.locationMatchLog.findUnique({
      where: { id: logId },
      include: { terminal: true, berth: true },
    });

    if (!log) {
      throw new Error("Location match log not found.");
    }

    const aliasName = normalizeLocationName(log.rawName);
    const normalizedName = canonicalizeLocationKey(aliasName);

    if (!normalizedName) {
      throw new Error("Could not normalize alias name.");
    }

    if (log.entityType === LocationEntityType.TERMINAL) {
      if (!log.terminalId) throw new Error("No terminal is attached to this log.");
      await tx.terminalAlias.upsert({
        where: {
          terminalId_normalizedName: {
            terminalId: log.terminalId,
            normalizedName,
          },
        },
        update: { name: aliasName },
        create: {
          terminalId: log.terminalId,
          name: aliasName,
          normalizedName,
        },
      });
    } else {
      if (!log.berthId) throw new Error("No berth is attached to this log.");
      await tx.berthAlias.upsert({
        where: {
          berthId_normalizedName: {
            berthId: log.berthId,
            normalizedName,
          },
        },
        update: { name: aliasName },
        create: {
          berthId: log.berthId,
          name: aliasName,
          normalizedName,
        },
      });
    }

    return tx.locationMatchLog.update({
      where: { id: logId },
      data: {
        status: LocationMatchStatus.MATCHED,
        confidence: MatchConfidence.HIGH,
        method: log.method === LocationMatchMethod.CREATED_NEW ? LocationMatchMethod.ALIAS : log.method,
        reason: appendReviewReason(log.reason, "Review action: alias promoted to the matched entity."),
      },
    });
  });
}

async function createSeparateEntity(logId: number) {
  return prisma.$transaction(async (tx) => {
    const log = await tx.locationMatchLog.findUnique({
      where: { id: logId },
      include: {
        sourceRecord: true,
        berth: true,
        terminal: true,
      },
    });

    if (!log) {
      throw new Error("Location match log not found.");
    }

    const rawName = normalizeLocationName(log.rawName);
    const normalizedName = canonicalizeLocationKey(rawName);

    if (!normalizedName) {
      throw new Error("Could not normalize location name.");
    }

    if (log.entityType === LocationEntityType.TERMINAL) {
      const existingTerminal = await tx.terminal.findFirst({
        where: { portId: log.portId, normalizedName },
      });

      if (existingTerminal && existingTerminal.id === log.terminalId) {
        throw new Error(
          "A separate terminal cannot be created because the normalized name still resolves to the current terminal. Adjust normalization or rename the raw entity first."
        );
      }

      const terminal =
        existingTerminal ||
        (await tx.terminal.create({
          data: {
            portId: log.portId,
            name: rawName,
            normalizedName,
            aliases: {
              create: {
                name: rawName,
                normalizedName,
              },
            },
          },
        }));

      if (log.sourceRecordId) {
        await tx.sourceRecord.update({
          where: { id: log.sourceRecordId },
          data: {
            terminalId: terminal.id,
            berthId: null,
          },
        });

        await tx.portFact.updateMany({
          where: {
            sourceRecordId: log.sourceRecordId,
            portId: log.portId,
            scope: { in: ["TERMINAL", "BERTH"] },
          },
          data: {
            terminalId: terminal.id,
            berthId: null,
          },
        });
      }

      return tx.locationMatchLog.update({
        where: { id: logId },
        data: {
          terminalId: terminal.id,
          berthId: null,
          matchedName: terminal.name,
          method: LocationMatchMethod.CREATED_NEW,
          status: LocationMatchStatus.CREATED_NEW,
          confidence: MatchConfidence.HIGH,
          reason: appendReviewReason(
            log.reason,
            "Review action: created or attached a separate terminal entity."
          ),
        },
      });
    }

    const parentTerminalId =
      log.berth?.terminalId ?? log.sourceRecord?.terminalId ?? log.terminalId ?? null;

    const existingBerth = await tx.berth.findFirst({
      where: {
        portId: log.portId,
        terminalId: parentTerminalId,
        normalizedName,
      },
    });

    if (existingBerth && existingBerth.id === log.berthId) {
      throw new Error(
        "A separate berth cannot be created because the normalized name still resolves to the current berth. Adjust normalization or rename the raw entity first."
      );
    }

    const berth =
      existingBerth ||
      (await tx.berth.create({
        data: {
          portId: log.portId,
          terminalId: parentTerminalId,
          name: rawName,
          normalizedName,
          aliases: {
            create: {
              name: rawName,
              normalizedName,
            },
          },
        },
      }));

    if (log.sourceRecordId) {
      await tx.sourceRecord.update({
        where: { id: log.sourceRecordId },
        data: {
          berthId: berth.id,
          terminalId: berth.terminalId ?? log.sourceRecord?.terminalId ?? null,
        },
      });

      await tx.portFact.updateMany({
        where: {
          sourceRecordId: log.sourceRecordId,
          portId: log.portId,
          scope: "BERTH",
        },
        data: {
          berthId: berth.id,
          terminalId: berth.terminalId ?? log.sourceRecord?.terminalId ?? null,
        },
      });
    }

    return tx.locationMatchLog.update({
      where: { id: logId },
      data: {
        berthId: berth.id,
        terminalId: berth.terminalId ?? log.terminalId ?? null,
        matchedName: berth.name,
        method: LocationMatchMethod.CREATED_NEW,
        status: LocationMatchStatus.CREATED_NEW,
        confidence: MatchConfidence.HIGH,
        reason: appendReviewReason(
          log.reason,
          "Review action: created or attached a separate berth entity."
        ),
      },
    });
  });
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { action } = (await req.json()) as { action?: string };
    const { id } = await context.params;
    const logId = Number(id);

    if (!Number.isFinite(logId)) {
      return NextResponse.json({ error: "Invalid log id." }, { status: 400 });
    }

    if (!action) {
      return NextResponse.json({ error: "Action is required." }, { status: 400 });
    }

    if (action === "confirm") {
      await confirmMatch(logId);
    } else if (action === "promote-alias") {
      await promoteAlias(logId);
    } else if (action === "create-separate") {
      await createSeparateEntity(logId);
    } else {
      return NextResponse.json({ error: "Unknown review action." }, { status: 400 });
    }

    revalidatePath("/review");
    revalidatePath("/");

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Review action failed.",
      },
      { status: 500 }
    );
  }
}
