import {
  normalizeBunkerFact,
  parseBunkerModes,
} from "../lib/bunker-semantics.ts";

const CASES = [
  {
    name: "Anchorage only",
    fact: {
      category: "bunker",
      value: "Bunkers at anchorage only ex Barge",
      notes: "Bunkering operations restricted to anchorage",
      rawSnippet: "Where the bunkering ops take place? Anchorage / alongside? Bunkers at anchorage only ex Barge",
    },
    expectedCategory: "bunker",
    expectedModes: ["anchorage_only", "barge_only", "conditional_mixed"],
    expectedValue: "Conditional / mixed bunkering arrangement",
  },
  {
    name: "Anchorage or alongside",
    fact: {
      category: "bunker",
      value: "Can be alongside or at anchorage",
      notes: null,
      rawSnippet: "Where the bunkering ops take place? Anchorage / alongside? Can be alongside or at anchorage",
    },
    expectedCategory: "bunker",
    expectedModes: ["anchorage_or_alongside"],
    expectedValue: "Bunkering at anchorage or alongside",
  },
  {
    name: "Truck only otherwise anchorage",
    fact: {
      category: "bunker",
      value: "Small delivery via truck only; otherwise bunkering at anchorage",
      notes: "Bunkering location details",
      rawSnippet: "Where the bunkering ops take place? Small Delivery via Truck Only, Otherwise at anchorage.",
    },
    expectedCategory: "bunker",
    expectedModes: ["truck_only", "conditional_mixed"],
    expectedValue: "Conditional / mixed bunkering arrangement",
  },
  {
    name: "Not available",
    fact: {
      category: "bunker",
      value: "No bunkers available at Kitimat",
      notes: null,
      rawSnippet: "No bunkers available at Kitimat.",
    },
    expectedCategory: "bunker",
    expectedModes: ["not_available"],
    expectedValue: "No bunkers available",
  },
  {
    name: "Fuel spec becomes sulphur",
    fact: {
      category: "bunker",
      value: "< 0.1% sulphur",
      notes: "Bunker fuel sulphur capped below 0.1%",
      rawSnippet: "What bunkers to be consumed in port ( < 0.5% sulphur / < 0.1% sulphur)?: < 0.1% sulphur",
    },
    expectedCategory: "sulphur",
    expectedModes: [],
    expectedValue: "< 0.1% sulphur",
  },
];

let failures = 0;

for (const testCase of CASES) {
  const modes = Array.from(parseBunkerModes(testCase.fact)).sort();
  const normalized = normalizeBunkerFact(testCase.fact);
  const expectedModes = [...testCase.expectedModes].sort();

  const modesOk = JSON.stringify(modes) === JSON.stringify(expectedModes);
  const categoryOk = normalized.category === testCase.expectedCategory;
  const valueOk = normalized.value === testCase.expectedValue;

  if (!modesOk || !categoryOk || !valueOk) {
    failures += 1;
    console.error(`\n[FAIL] ${testCase.name}`);
    console.error(`  expected category: ${testCase.expectedCategory}`);
    console.error(`  actual category:   ${normalized.category}`);
    console.error(`  expected value:    ${testCase.expectedValue}`);
    console.error(`  actual value:      ${normalized.value}`);
    console.error(`  expected modes:    ${expectedModes.join(", ") || "(none)"}`);
    console.error(`  actual modes:      ${modes.join(", ") || "(none)"}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} bunker semantics regression case(s) failed.`);
  process.exit(1);
}

console.log(`All ${CASES.length} bunker semantics regression cases passed.`);
