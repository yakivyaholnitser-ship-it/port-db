function normalizeLocationName(value) {
  return value.replace(/\s+/g, " ").trim();
}

function canonicalizeLocationKey(value) {
  return normalizeLocationName(value)
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/\bterminals\b/g, " terminal ")
    .replace(/\bterminal\b/g, " ")
    .replace(/\bberths\b/g, " berth ")
    .replace(/\bberth\s+no\.?\s*/g, " berth ")
    .replace(/\bberth\b/g, " ")
    .replace(/\bwharves\b/g, " wharf ")
    .replace(/\belevators\b/g, " elevator ")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

let prisma;

const FIXTURES = [
  {
    port: { name: "Ningbo", country: "China" },
    terminals: [
      {
        name: "CT3",
        aliases: ["Ningbo CT3"],
      },
      {
        name: "Phase 2",
        aliases: ["Beilun Phase 2", "Phase II"],
      },
      {
        name: "Ore Terminal",
        aliases: ["Ore berth area"],
        berths: [
          {
            name: "Berth No. 1",
            aliases: ["Ore berth no.1", "Berth 1"],
          },
        ],
      },
    ],
  },
  {
    port: { name: "Majishan", country: "China" },
    terminals: [
      {
        name: "Ore Jetty",
        aliases: ["Majishan Ore Jetty"],
        berths: [
          {
            name: "3# Berth",
            aliases: ["3# berth", "Berth 3"],
          },
        ],
      },
    ],
  },
  {
    port: { name: "Kandla", country: "India" },
    terminals: [
      {
        name: "Oil Jetty",
        aliases: ["Kandla Oil Jetty"],
        berths: [
          {
            name: "Jetty No. 7",
            aliases: ["Oil jetty no.7", "Jetty 7"],
          },
        ],
      },
    ],
  },
  {
    port: { name: "Mesaieed", country: "Qatar" },
    terminals: [
      {
        name: "Main Terminal",
        aliases: ["Mesaieed Main Terminal"],
        berths: [
          {
            name: "Berth A",
            aliases: ["berth A", "A berth"],
          },
        ],
      },
    ],
  },
  {
    port: { name: "Jebel Ali", country: "UAE" },
    terminals: [
      {
        name: "CT2",
        aliases: ["Jebel Ali CT2"],
        berths: [
          {
            name: "Berth 5",
            aliases: ["CT2 berth 5"],
          },
        ],
      },
    ],
  },
  {
    port: { name: "Piraeus", country: "Greece" },
    terminals: [
      {
        name: "Terminal II",
        aliases: ["Terminal 2", "Piraeus Terminal II"],
        berths: [
          {
            name: "Berth 3",
            aliases: ["terminal II berth 3", "terminal 2 berth 3"],
          },
        ],
      },
    ],
  },
  {
    port: { name: "Antwerp", country: "Belgium" },
    terminals: [
      {
        name: "Deurganckdok",
        aliases: ["Antwerp Deurganckdok"],
        berths: [
          {
            name: "Berth 1732",
            aliases: ["Deurganckdok berth 1732"],
          },
        ],
      },
    ],
  },
  {
    port: { name: "Santos", country: "Brazil" },
    terminals: [
      {
        name: "T-Granel",
        aliases: ["Santos T-Granel", "T Granel"],
        berths: [
          {
            name: "Berth 2",
            aliases: ["T-Granel berth 2"],
          },
        ],
      },
    ],
  },
  {
    port: { name: "Richards Bay", country: "South Africa" },
    terminals: [
      {
        name: "CT",
        aliases: ["Richards Bay CT"],
        berths: [
          {
            name: "Berth 203",
            aliases: ["CT berth 203"],
          },
        ],
      },
    ],
  },
  {
    port: { name: "Hay Point", country: "Australia" },
    terminals: [
      {
        name: "CT7",
        aliases: ["Hay Point CT7"],
      },
    ],
  },
];

async function upsertPort(port) {
  const normalizedName = canonicalizeLocationKey(port.name);
  const existing = await prisma.port.findFirst({
    where: {
      OR: [
        { normalizedName, country: port.country },
        { name: { equals: port.name, mode: "insensitive" }, country: port.country },
      ],
    },
  });

  if (existing) {
    return prisma.port.update({
      where: { id: existing.id },
      data: {
        name: existing.name || port.name,
        normalizedName,
        country: existing.country || port.country,
      },
    });
  }

  return prisma.port.create({
    data: {
      name: port.name,
      normalizedName,
      country: port.country,
    },
  });
}

async function upsertTerminal(portId, terminal) {
  const normalizedName = canonicalizeLocationKey(terminal.name);
  const existing = await prisma.terminal.findFirst({
    where: {
      portId,
      OR: [
        { normalizedName },
        { name: { equals: terminal.name, mode: "insensitive" } },
      ],
    },
  });

  const saved = existing
    ? await prisma.terminal.update({
        where: { id: existing.id },
        data: {
          name: existing.name || terminal.name,
          normalizedName,
        },
      })
    : await prisma.terminal.create({
        data: {
          portId,
          name: terminal.name,
          normalizedName,
        },
      });

  const aliases = Array.from(new Set([terminal.name, ...(terminal.aliases || [])]));
  for (const alias of aliases) {
    const normalizedAlias = canonicalizeLocationKey(alias);
    await prisma.terminalAlias.upsert({
      where: {
        terminalId_normalizedName: {
          terminalId: saved.id,
          normalizedName: normalizedAlias,
        },
      },
      update: { name: alias },
      create: {
        terminalId: saved.id,
        name: alias,
        normalizedName: normalizedAlias,
      },
    });
  }

  return saved;
}

async function upsertBerth(portId, terminalId, berth) {
  const normalizedName = canonicalizeLocationKey(berth.name);
  const existing = await prisma.berth.findFirst({
    where: {
      portId,
      terminalId,
      OR: [
        { normalizedName },
        { name: { equals: berth.name, mode: "insensitive" } },
      ],
    },
  });

  const saved = existing
    ? await prisma.berth.update({
        where: { id: existing.id },
        data: {
          name: existing.name || berth.name,
          normalizedName,
          terminalId,
        },
      })
    : await prisma.berth.create({
        data: {
          portId,
          terminalId,
          name: berth.name,
          normalizedName,
        },
      });

  const aliases = Array.from(new Set([berth.name, ...(berth.aliases || [])]));
  for (const alias of aliases) {
    const normalizedAlias = canonicalizeLocationKey(alias);
    await prisma.berthAlias.upsert({
      where: {
        berthId_normalizedName: {
          berthId: saved.id,
          normalizedName: normalizedAlias,
        },
      },
      update: { name: alias },
      create: {
        berthId: saved.id,
        name: alias,
        normalizedName: normalizedAlias,
      },
    });
  }

  return saved;
}

async function main() {
  const { PrismaClient } = await import("@prisma/client");
  prisma = new PrismaClient();

  try {
    for (const fixture of FIXTURES) {
      const port = await upsertPort(fixture.port);
      for (const terminal of fixture.terminals) {
        const savedTerminal = await upsertTerminal(port.id, terminal);
        for (const berth of terminal.berths || []) {
          await upsertBerth(port.id, savedTerminal.id, berth);
        }
      }
    }

    console.log(`Seeded ${FIXTURES.length} global location fixture ports.`);
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
