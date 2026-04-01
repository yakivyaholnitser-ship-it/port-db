/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient, PortFactScope } = require("@prisma/client");

const prisma = new PrismaClient();

function isBadTerminalName(name) {
  return /air draft|aircraft|cargo holds survey|stability calculation|port state control|grain loading equipment|operational hours|minimum depth|height of tide|tide range|bunker fuel sulphur|bunker fuel sulfur|fuel sulphur|fuel sulfur|where bunkering|where the bunkering ops take place|transit time|under keel clearance|water density|load rate|discharge rate|maximum beam|maximum length|max draft|at zero tide|cleaning permitted|draft along side|pipes\s*\d|based on 1 gang|grain terminal|hudbay \/ jan 2026|-\s*sulphur$|-\s*sulfur$/i.test(
    name
  );
}

async function main() {
  const port = await prisma.port.findFirst({
    where: { name: { contains: "Vancouver", mode: "insensitive" } },
    include: {
      terminals: {
        include: { berths: true },
      },
    },
  });

  if (!port) {
    throw new Error("Vancouver not found");
  }

  const badTerminals = port.terminals.filter((terminal) => isBadTerminalName(terminal.name));
  const badTerminalIds = badTerminals.map((terminal) => terminal.id);
  const badBerthIds = badTerminals.flatMap((terminal) => terminal.berths.map((berth) => berth.id));

  if (badTerminalIds.length === 0) {
    console.log(JSON.stringify({ cleaned: 0, message: "No bad terminals found" }, null, 2));
    return;
  }

  await prisma.portFact.updateMany({
    where: {
      OR: [
        { terminalId: { in: badTerminalIds } },
        { berthId: { in: badBerthIds } },
      ],
    },
    data: {
      scope: PortFactScope.PORT,
      terminalId: null,
      berthId: null,
    },
  });

  await prisma.sourceRecord.updateMany({
    where: {
      OR: [
        { terminalId: { in: badTerminalIds } },
        { berthId: { in: badBerthIds } },
      ],
    },
    data: {
      terminalId: null,
      berthId: null,
    },
  });

  await prisma.berthAlias.deleteMany({
    where: { berthId: { in: badBerthIds } },
  });
  await prisma.terminalAlias.deleteMany({
    where: { terminalId: { in: badTerminalIds } },
  });
  await prisma.berth.deleteMany({
    where: { id: { in: badBerthIds } },
  });
  await prisma.terminal.deleteMany({
    where: { id: { in: badTerminalIds } },
  });

  console.log(
    JSON.stringify(
      {
        cleanedTerminals: badTerminals.map((terminal) => terminal.name),
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
