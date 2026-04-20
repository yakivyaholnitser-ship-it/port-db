import { PrismaClient } from "@prisma/client";
import { normalizeBunkerFact } from "../lib/bunker-semantics.ts";

const prisma = new PrismaClient();

async function main() {
  const facts = await prisma.portFact.findMany({
    where: {
      category: {
        in: ["bunker", "sulphur"],
      },
    },
    select: {
      id: true,
      category: true,
      value: true,
      unit: true,
      notes: true,
      rawSnippet: true,
    },
    orderBy: { id: "asc" },
  });

  let updated = 0;
  const changed = [];

  for (const fact of facts) {
    const normalized = normalizeBunkerFact({
      category: fact.category,
      value: fact.value,
      unit: fact.unit,
      notes: fact.notes,
      rawSnippet: fact.rawSnippet,
    });

    const nextCategory = normalized.category;
    const nextValue = normalized.value;
    const nextNotes = normalized.notes ?? null;

    if (
      nextCategory === fact.category &&
      nextValue === fact.value &&
      nextNotes === (fact.notes ?? null)
    ) {
      continue;
    }

    await prisma.portFact.update({
      where: { id: fact.id },
      data: {
        category: nextCategory,
        value: nextValue,
        notes: nextNotes,
      },
    });

    updated += 1;
    changed.push({
      id: fact.id,
      from: {
        category: fact.category,
        value: fact.value,
        notes: fact.notes,
      },
      to: {
        category: nextCategory,
        value: nextValue,
        notes: nextNotes,
      },
    });
  }

  console.log(
    JSON.stringify(
      {
        scanned: facts.length,
        updated,
        changed: changed.slice(0, 50),
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
