import { prisma } from "@/lib/prisma";

export async function deletePortGraph(portId: number) {
  const terminalIds = (
    await prisma.terminal.findMany({
      where: { portId },
      select: { id: true },
    })
  ).map((terminal) => terminal.id);

  const berthIds = (
    await prisma.berth.findMany({
      where: { portId },
      select: { id: true },
    })
  ).map((berth) => berth.id);

  await prisma.$transaction(async (tx) => {
    if (berthIds.length > 0) {
      await tx.berthAlias.deleteMany({ where: { berthId: { in: berthIds } } });
    }

    if (terminalIds.length > 0) {
      await tx.terminalAlias.deleteMany({ where: { terminalId: { in: terminalIds } } });
    }

    await tx.locationMatchLog.deleteMany({ where: { portId } });
    await tx.portFact.deleteMany({ where: { portId } });
    await tx.sourceRecord.deleteMany({ where: { portId } });
    await tx.berth.deleteMany({ where: { portId } });
    await tx.terminal.deleteMany({ where: { portId } });
    await tx.port.delete({ where: { id: portId } });
  });
}

export async function deleteTerminalGraph(terminalId: number) {
  const terminal = await prisma.terminal.findUnique({
    where: { id: terminalId },
    select: { id: true, portId: true },
  });

  if (!terminal) return false;

  const berthIds = (
    await prisma.berth.findMany({
      where: { terminalId },
      select: { id: true },
    })
  ).map((berth) => berth.id);

  await prisma.$transaction(async (tx) => {
    if (berthIds.length > 0) {
      await tx.berthAlias.deleteMany({ where: { berthId: { in: berthIds } } });
    }

    await tx.terminalAlias.deleteMany({ where: { terminalId } });
    await tx.locationMatchLog.deleteMany({
      where: {
        OR: [{ terminalId }, { berthId: { in: berthIds.length > 0 ? berthIds : [-1] } }],
      },
    });
    await tx.portFact.deleteMany({ where: { OR: [{ terminalId }, { berthId: { in: berthIds } }] } });
    await tx.sourceRecord.deleteMany({
      where: { OR: [{ terminalId }, { berthId: { in: berthIds } }] },
    });
    await tx.berth.deleteMany({ where: { terminalId } });
    await tx.terminal.delete({ where: { id: terminalId } });
  });

  return true;
}

export async function deleteBerthGraph(berthId: number) {
  const berth = await prisma.berth.findUnique({
    where: { id: berthId },
    select: { id: true },
  });

  if (!berth) return false;

  await prisma.$transaction(async (tx) => {
    await tx.berthAlias.deleteMany({ where: { berthId } });
    await tx.locationMatchLog.deleteMany({ where: { berthId } });
    await tx.portFact.deleteMany({ where: { berthId } });
    await tx.sourceRecord.deleteMany({ where: { berthId } });
    await tx.berth.delete({ where: { id: berthId } });
  });

  return true;
}

export async function deleteFactGraph(factId: number) {
  const fact = await prisma.portFact.findUnique({
    where: { id: factId },
    select: { id: true, sourceRecordId: true },
  });

  if (!fact) return false;

  await prisma.$transaction(async (tx) => {
    await tx.portFact.delete({ where: { id: factId } });

    const remainingFacts = await tx.portFact.count({
      where: { sourceRecordId: fact.sourceRecordId },
    });

    if (remainingFacts === 0) {
      await tx.locationMatchLog.deleteMany({
        where: { sourceRecordId: fact.sourceRecordId },
      });
      await tx.sourceRecord.delete({
        where: { id: fact.sourceRecordId },
      });
    }
  });

  return true;
}
