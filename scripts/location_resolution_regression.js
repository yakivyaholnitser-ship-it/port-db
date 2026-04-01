const DEFAULT_BASE_URL = process.env.PORT_DB_BASE_URL || "http://localhost:3001";

function normalize(value) {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function same(actual, expected) {
  return normalize(actual) === normalize(expected);
}

async function runCase(baseUrl, testCase, index) {
  const sourceDate = "2026-03-29";
  const source = `Location regression ${index + 1}`;

  const response = await fetch(`${baseUrl}/api/ingest-v2`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: testCase.text,
      source,
      sourceDate,
    }),
  });

  const raw = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Non-JSON response (${response.status}): ${raw}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${parsed.error || raw}`);
  }

  const mismatches = [];
  if (!same(parsed.port?.name, testCase.expected.port)) {
    mismatches.push(`port expected "${testCase.expected.port}" got "${parsed.port?.name ?? "null"}"`);
  }
  if ("country" in testCase.expected && !same(parsed.port?.country, testCase.expected.country)) {
    mismatches.push(
      `country expected "${testCase.expected.country}" got "${parsed.port?.country ?? "null"}"`
    );
  }
  if (!same(parsed.terminal?.name, testCase.expected.terminal)) {
    mismatches.push(
      `terminal expected "${testCase.expected.terminal}" got "${parsed.terminal?.name ?? "null"}"`
    );
  }

  const expectedBerth = testCase.expected.berth;
  const actualBerth = parsed.berth?.name ?? null;
  if (expectedBerth === null) {
    if (actualBerth !== null) {
      mismatches.push(`berth expected null got "${actualBerth}"`);
    }
  } else if (!same(actualBerth, expectedBerth)) {
    mismatches.push(`berth expected "${expectedBerth}" got "${actualBerth ?? "null"}"`);
  }

  if (Array.isArray(testCase.expectedStoredFacts) && testCase.expectedStoredFacts.length > 0) {
    const detailResponse = await fetch(`${baseUrl}/api/ports-v2?portId=${parsed.port?.id}`);
    const detailRaw = await detailResponse.text();
    let detail;
    try {
      detail = JSON.parse(detailRaw);
    } catch {
      throw new Error(`Non-JSON detail response (${detailResponse.status}): ${detailRaw}`);
    }

    if (!detailResponse.ok) {
      throw new Error(`Detail HTTP ${detailResponse.status}: ${detail.error || detailRaw}`);
    }

    for (const expectedFact of testCase.expectedStoredFacts) {
      const matched = (detail.facts || []).find((fact) => {
        if (!same(fact.source, source)) return false;
        if (!same(fact.category, expectedFact.category)) return false;
        if (!same(fact.scope, expectedFact.scope)) return false;
        if ("terminal" in expectedFact) {
          return same(fact.locationLabel, expectedFact.terminal);
        }
        if ("locationLabel" in expectedFact) {
          return same(fact.locationLabel, expectedFact.locationLabel);
        }
        return true;
      });

      if (!matched) {
        mismatches.push(
          `stored fact missing category="${expectedFact.category}" scope="${expectedFact.scope}"` +
            ("terminal" in expectedFact ? ` terminal="${expectedFact.terminal}"` : "")
        );
      }
    }
  }

  return {
    ok: mismatches.length === 0,
    response: parsed,
    mismatches,
  };
}

async function main() {
  const { getEnabledLocationCases, summarizeCorpus } = await import(
    "./location_resolution_global_corpus.js"
  );
  const CASES = getEnabledLocationCases();
  const baseUrl = DEFAULT_BASE_URL;
  console.log(`Running location resolution regression against ${baseUrl}`);
  const corpusSummary = summarizeCorpus();
  const totalCases = corpusSummary.reduce((sum, row) => sum + row.total, 0);
  const enabledCases = corpusSummary.reduce((sum, row) => sum + row.enabled, 0);
  console.log(`Global corpus: ${totalCases} cases across ${corpusSummary.length} regions`);
  console.log(`Enabled now: ${enabledCases} live cases`);

  let failures = 0;

  for (const [index, testCase] of CASES.entries()) {
    try {
      const result = await runCase(baseUrl, testCase, index);
      if (result.ok) {
        console.log(`PASS  ${testCase.name}`);
      } else {
        failures++;
        console.error(`FAIL  ${testCase.name}`);
        for (const mismatch of result.mismatches) {
          console.error(`  - ${mismatch}`);
        }
      }
    } catch (error) {
      failures++;
      console.error(`FAIL  ${testCase.name}`);
      console.error(`  - ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} regression case(s) failed.`);
    process.exit(1);
  }

  console.log(`\nAll ${CASES.length} location resolution regression cases passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
