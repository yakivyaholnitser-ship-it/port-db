/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient, PortFactScope } = require("@prisma/client");

const prisma = new PrismaClient();

function isBadLocationName(name) {
  const lower = name.toLowerCase().trim();
  if (!lower) return false;

  return /air draft|aircraft|cargo holds survey|stability calculation|port state control|grain loading equipment|operational hours|minimum depth|height of tide|tide range|bunker fuel sulphur|bunker fuel sulfur|fuel sulphur|fuel sulfur|where bunkering|where the bunkering ops take place|transit time|under keel clearance|water density|load rate|discharge rate|maximum beam|maximum length|max draft|at zero tide|cleaning permitted|draft along side|pipes\s*\d|based on 1 gang|-\s*sulphur$|-\s*sulfur$/i.test(
    lower
  );
}

async function main() {
  const ports = await prisma.port.findMany({
    include: {
      terminals: {
        include: { berths: true },
      },
      berths: {
        where: { terminalId: null },
      },
    },
    orderBy: { name: "asc" },
  });

  const badTerminals = ports.flatMap((port) =>
    port.terminals
      .filter((terminal) => isBadLocationName(terminal.name))
      .map((terminal) => ({ ...terminal, portName: port.name }))
  );
  const badTerminalIds = badTerminals.map((terminal) => terminal.id);
  const badBerthIds = badTerminals.flatMap((terminal) => terminal.berths.map((berth) => berth.id));
  const badStandaloneBerths = ports.flatMap((port) =>
    port.berths
      .filter((berth) => isBadLocationName(berth.name))
      .map((berth) => ({ ...berth, portName: port.name }))
  );
  const badStandaloneBerthIds = badStandaloneBerths.map((berth) => berth.id);

  if (
    badTerminalIds.length === 0 &&
    badBerthIds.length === 0 &&
    badStandaloneBerthIds.length === 0
  ) {
    console.log(JSON.stringify({ cleaned: 0, message: "No bad location entities found" }, null, 2));
    return;
  }

  await prisma.portFact.updateMany({
    where: {
      OR: [
        { terminalId: { in: badTerminalIds } },
        { berthId: { in: [...badBerthIds, ...badStandaloneBerthIds] } },
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
        { berthId: { in: [...badBerthIds, ...badStandaloneBerthIds] } },
      ],
    },
    data: {
      terminalId: null,
      berthId: null,
    },
  });

  await prisma.berthAlias.deleteMany({
    where: { berthId: { in: [...badBerthIds, ...badStandaloneBerthIds] } },
  });
  await prisma.terminalAlias.deleteMany({
    where: { terminalId: { in: badTerminalIds } },
  });
  await prisma.berth.deleteMany({
    where: { id: { in: [...badBerthIds, ...badStandaloneBerthIds] } },
  });
  await prisma.terminal.deleteMany({
    where: { id: { in: badTerminalIds } },
  });

  console.log(
    JSON.stringify(
      {
        cleanedTerminals: badTerminals.map((terminal) => `${terminal.portName}: ${terminal.name}`),
        cleanedStandaloneBerths: badStandaloneBerths.map(
          (berth) => `${berth.portName}: ${berth.name}`
        ),
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
