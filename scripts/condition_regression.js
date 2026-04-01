function normalize(value) {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function same(actual, expected) {
  return normalize(actual) === normalize(expected);
}

function unique(values) {
  return Array.from(new Set(values));
}

function parseOperationalConditions(...inputs) {
  const text = inputs.filter(Boolean).join(" ");
  const lower = text.toLowerCase();

  const waterType = [];
  if (/\b(sw|salt water)\b/i.test(lower)) waterType.push("SW");
  if (/\b(fw|fresh water)\b/i.test(lower)) waterType.push("FW");
  if (/\bbw\b|\bbrackish\b/i.test(lower)) waterType.push("Brackish");

  const densityValues = unique(
    Array.from(lower.matchAll(/\b(?:density\s*(?:of|=|:)?\s*)?(1\.\d{3})\b/gi))
      .map((match) => match[1])
      .filter(Boolean)
  );

  const tideTags = [];
  if (/\bzero tide\b|\b0 m tide\b|\bat zero tide\b/i.test(lower)) tideTags.push("Zero tide");
  if (/\bhigh water\b|\bhw\b/i.test(lower)) tideTags.push("HW");
  if (/\blow water\b|\blw\b/i.test(lower)) tideTags.push("LW");
  if (/\+\/-\s*tide|\btide affected\b/i.test(lower)) tideTags.push("Tide affected");

  const movementPhase = [];
  if (/\barrival\b/i.test(lower)) movementPhase.push("Arrival");
  if (/\bdeparture\b/i.test(lower)) movementPhase.push("Departure");

  const infrastructureTags = [];
  if (/\bspm\b|\bsingle point mooring\b/i.test(lower)) infrastructureTags.push("SPM");
  if (/\bsbm\b|\bsingle buoy mooring\b/i.test(lower)) infrastructureTags.push("SBM");
  if (/\bcbm\b|\bconventional buoy mooring\b/i.test(lower)) infrastructureTags.push("CBM");

  return {
    waterType: unique(waterType),
    densityValues,
    tideTags: unique(tideTags),
    movementPhase: unique(movementPhase),
    infrastructureTags: unique(infrastructureTags),
    naabsa: /\bnaabsa\b/i.test(lower),
  };
}

function conditionTagsFromParsed(parsed) {
  return unique([
    ...parsed.waterType,
    ...parsed.densityValues.map((value) => `Density ${value}`),
    ...parsed.tideTags,
    ...parsed.movementPhase,
    ...parsed.infrastructureTags,
    ...(parsed.naabsa ? ["NAABSA"] : []),
  ]);
}

function locationLabel(portName, fact) {
  if (fact.scope === "BERTH") {
    return [fact.terminal?.name, fact.berth?.name].filter(Boolean).join(" / ") || portName;
  }
  if (fact.scope === "TERMINAL") {
    return fact.terminal?.name || portName;
  }
  return portName;
}

async function loadFactsForPort(prisma, portName) {
  const port = await prisma.port.findFirst({
    where: { name: { equals: portName, mode: "insensitive" } },
    include: {
      facts: {
        include: {
          sourceRecord: true,
          terminal: true,
          berth: true,
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  return port;
}

async function main() {
  const { PrismaClient } = await import("@prisma/client");
  const { getEnabledConditionCases } = await import("./condition_regression_global_corpus.js");
  const prisma = new PrismaClient();

  try {
    const cases = getEnabledConditionCases();
    console.log(`Running condition regression against live database`);

    let failures = 0;

    for (const testCase of cases) {
      const port = await loadFactsForPort(prisma, testCase.port);
      if (!port) {
        failures++;
        console.error(`FAIL  ${testCase.name}`);
        console.error(`  - port not found: ${testCase.port}`);
        continue;
      }

      const matchingFact = port.facts.find(
        (fact) =>
          same(fact.sourceRecord?.sourceName, "Condition Fixture") &&
          same(fact.category, testCase.category) &&
          same(locationLabel(port.name, fact), testCase.locationLabel) &&
          normalize(fact.value).includes(normalize(testCase.observationValue))
      );

      if (!matchingFact) {
        failures++;
        console.error(`FAIL  ${testCase.name}`);
        console.error(
          `  - fact not found for ${testCase.locationLabel} / ${testCase.category} / ${testCase.observationValue}`
        );
        continue;
      }

      const parsed = parseOperationalConditions(
        matchingFact.value,
        matchingFact.unit,
        matchingFact.notes
      );
      const tags = conditionTagsFromParsed(parsed);
      const missingTags = testCase.expectedTags.filter(
        (tag) => !tags.some((actualTag) => same(actualTag, tag))
      );

      if (missingTags.length > 0) {
        failures++;
        console.error(`FAIL  ${testCase.name}`);
        for (const tag of missingTags) {
          console.error(`  - missing tag "${tag}"`);
        }
        continue;
      }

      console.log(`PASS  ${testCase.name}`);
    }

    if (failures > 0) {
      console.error(`\n${failures} condition regression case(s) failed.`);
      process.exit(1);
    }

    console.log(`\nAll ${cases.length} condition regression cases passed.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
