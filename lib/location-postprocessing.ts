import { Prisma } from "@prisma/client";
import { canonicalizeLocationKey, normalizeLocationName } from "@/lib/location-matching";

type DbClient = Prisma.TransactionClient | Prisma.DefaultPrismaClient;

async function upsertTerminalAlias(
  db: DbClient,
  args: { terminalId: number; name: string; normalizedName: string }
) {
  const terminalAliasModel = (db as DbClient & {
    terminalAlias?: {
      upsert: (args: {
        where: { terminalId_normalizedName: { terminalId: number; normalizedName: string } };
        update: { name: string } | Record<string, never>;
        create: { terminalId: number; name: string; normalizedName: string };
      }) => Promise<unknown>;
    };
  }).terminalAlias;

  if (!terminalAliasModel?.upsert) return;

  await terminalAliasModel.upsert({
    where: {
      terminalId_normalizedName: {
        terminalId: args.terminalId,
        normalizedName: args.normalizedName,
      },
    },
    update: { name: args.name },
    create: args,
  });
}

async function upsertBerthAlias(
  db: DbClient,
  args: { berthId: number; name: string; normalizedName: string }
) {
  const berthAliasModel = (db as DbClient & {
    berthAlias?: {
      upsert: (args: {
        where: { berthId_normalizedName: { berthId: number; normalizedName: string } };
        update: { name: string } | Record<string, never>;
        create: { berthId: number; name: string; normalizedName: string };
      }) => Promise<unknown>;
    };
  }).berthAlias;

  if (!berthAliasModel?.upsert) return;

  await berthAliasModel.upsert({
    where: {
      berthId_normalizedName: {
        berthId: args.berthId,
        normalizedName: args.normalizedName,
      },
    },
    update: { name: args.name },
    create: args,
  });
}

export async function normalizeParentChildLocationNames(args: {
  db: DbClient;
  portId: number;
  terminalIds?: number[];
}) {
  const terminals = await args.db.terminal.findMany({
    where: {
      portId: args.portId,
      ...(args.terminalIds?.length ? { id: { in: args.terminalIds } } : {}),
    },
    include: {
      berths: true,
    },
    orderBy: { id: "asc" },
  });

  const normalized: {
    terminalId: number;
    from: string;
    to: string;
    canonicalBerth: string;
    removedDuplicateBerthId: number | null;
  }[] = [];

  for (const terminal of terminals) {
    const match = terminal.name.match(/^Berth\s+(\d+[A-Za-z-]*)\s*-\s*(.+)$/i);
    if (!match) continue;

    const berthNumber = match[1].trim();
    const operatorName = normalizeLocationName(match[2]);
    const canonicalBerthName = `Berth ${berthNumber}`;
    const oldTerminalName = terminal.name;
    const oldTerminalKey = terminal.normalizedName;
    const operatorKey = canonicalizeLocationKey(operatorName);
    const canonicalBerthKey = canonicalizeLocationKey(canonicalBerthName);

    const duplicateBerth = terminal.berths.find((berth) => berth.normalizedName === oldTerminalKey);
    const canonicalBerth = terminal.berths.find((berth) => berth.normalizedName === canonicalBerthKey);

    await args.db.terminal.update({
      where: { id: terminal.id },
      data: {
        name: operatorName,
        normalizedName: operatorKey,
      },
    });

    await upsertTerminalAlias(args.db, {
      terminalId: terminal.id,
      name: oldTerminalName,
      normalizedName: oldTerminalKey,
    });

    await upsertTerminalAlias(args.db, {
      terminalId: terminal.id,
      name: operatorName,
      normalizedName: operatorKey,
    });

    if (canonicalBerth) {
      await upsertBerthAlias(args.db, {
        berthId: canonicalBerth.id,
        name: oldTerminalName,
        normalizedName: oldTerminalKey,
      });
    }

    let removedDuplicateBerthId: number | null = null;

    if (duplicateBerth && canonicalBerth && duplicateBerth.id !== canonicalBerth.id) {
      await args.db.locationMatchLog.updateMany({
        where: { berthId: duplicateBerth.id },
        data: { berthId: canonicalBerth.id },
      });

      await args.db.berthAlias.deleteMany({ where: { berthId: duplicateBerth.id } });
      await args.db.berth.delete({ where: { id: duplicateBerth.id } });
      removedDuplicateBerthId = duplicateBerth.id;
    }

    normalized.push({
      terminalId: terminal.id,
      from: oldTerminalName,
      to: operatorName,
      canonicalBerth: canonicalBerthName,
      removedDuplicateBerthId,
    });
  }

  return normalized;
}
