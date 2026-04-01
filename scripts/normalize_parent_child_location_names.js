/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function canonicalizeLocationKey(value) {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/\bterminals\b/g, " terminal ")
    .replace(/\bterminal\b/g, " ")
    .replace(/\bberths\b/g, " berth ")
    .replace(/\bberth\s+no\.?\s*/g, " berth ")
    .replace(/\bberth\b/g, " ")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

async function normalizeBerthOperatorTerminal(terminal) {
  const match = terminal.name.match(/^Berth\s+(\d+[A-Za-z-]*)\s*-\s*(.+)$/i);
  if (!match) return null;

  const berthNumber = match[1].trim();
  const operatorName = match[2].trim();
  const canonicalBerthName = `Berth ${berthNumber}`;
  const oldTerminalName = terminal.name;
  const oldTerminalKey = terminal.normalizedName;
  const operatorKey = canonicalizeLocationKey(operatorName);
  const canonicalBerthKey = canonicalizeLocationKey(canonicalBerthName);

  const duplicateBerth = terminal.berths.find((berth) => berth.normalizedName === oldTerminalKey);
  const canonicalBerth = terminal.berths.find((berth) => berth.normalizedName === canonicalBerthKey);

  await prisma.$transaction(async (tx) => {
    await tx.terminal.update({
      where: { id: terminal.id },
      data: {
        name: operatorName,
        normalizedName: operatorKey,
      },
    });

    await tx.terminalAlias.upsert({
      where: {
        terminalId_normalizedName: {
          terminalId: terminal.id,
          normalizedName: oldTerminalKey,
        },
      },
      update: {
        name: oldTerminalName,
      },
      create: {
        terminalId: terminal.id,
        name: oldTerminalName,
        normalizedName: oldTerminalKey,
      },
    });

    await tx.terminalAlias.upsert({
      where: {
        terminalId_normalizedName: {
          terminalId: terminal.id,
          normalizedName: operatorKey,
        },
      },
      update: {
        name: operatorName,
      },
      create: {
        terminalId: terminal.id,
        name: operatorName,
        normalizedName: operatorKey,
      },
    });

    if (canonicalBerth) {
      await tx.berthAlias.upsert({
        where: {
          berthId_normalizedName: {
            berthId: canonicalBerth.id,
            normalizedName: oldTerminalKey,
          },
        },
        update: {
          name: oldTerminalName,
        },
        create: {
          berthId: canonicalBerth.id,
          name: oldTerminalName,
          normalizedName: oldTerminalKey,
        },
      });
    }

    if (duplicateBerth && canonicalBerth && duplicateBerth.id !== canonicalBerth.id) {
      await tx.locationMatchLog.updateMany({
        where: { berthId: duplicateBerth.id },
        data: { berthId: canonicalBerth.id },
      });

      await tx.berthAlias.deleteMany({ where: { berthId: duplicateBerth.id } });
      await tx.berth.delete({ where: { id: duplicateBerth.id } });
    }
  });

  return {
    terminalId: terminal.id,
    from: oldTerminalName,
    to: operatorName,
    canonicalBerth: canonicalBerthName,
    removedDuplicateBerthId: duplicateBerth && canonicalBerth && duplicateBerth.id !== canonicalBerth.id
      ? duplicateBerth.id
      : null,
  };
}

async function main() {
  const portName = getArg("port");

  const terminals = await prisma.terminal.findMany({
    where: portName
      ? { port: { name: { equals: portName, mode: "insensitive" } } }
      : {},
    include: {
      berths: true,
    },
    orderBy: { id: "asc" },
  });

  const results = [];

  for (const terminal of terminals) {
    const result = await normalizeBerthOperatorTerminal(terminal);
    if (result) results.push(result);
  }

  console.log(JSON.stringify({ processed: terminals.length, normalized: results }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
