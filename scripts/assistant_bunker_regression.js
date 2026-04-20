const DEFAULT_BASE_URL = process.env.PORT_DB_BASE_URL || "http://localhost:3001";

function normalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const CASES = [
  {
    name: "Anchorage only excludes mixed wording",
    question: "where is bunkering only at anchorage?",
    mustContain: ["anacortes", "pittsburg", "redwood city"],
    mustNotContain: ["conditional / mixed bunkering arrangement"],
  },
  {
    name: "Alongside allowed includes Vancouver",
    question: "what ports allow bunkering alongside?",
    mustContain: ["vancouver", "bunkering allowed alongside"],
  },
  {
    name: "Barge only finds Kalama",
    question: "where is bunkering by barge only?",
    mustContain: ["kalama", "barge only"],
  },
  {
    name: "Not available includes Kitimat",
    question: "where are bunkers not available?",
    mustContain: ["kitimat", "no bunkers available"],
  },
  {
    name: "Mixed arrangements include Sacramento or Kalama",
    question: "which ports have mixed bunkering arrangements?",
    mustContainOneOf: ["sacramento", "kalama", "conditional / mixed bunkering arrangement"],
  },
  {
    name: "Alongside-only terminal finds Muronoki",
    question: "show terminals where bunkering is only alongside",
    mustContain: ["iwakuni", "muronoki", "bunkering only alongside"],
  },
];

async function ask(baseUrl, question) {
  const res = await fetch(`${baseUrl}/api/assistant`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        {
          role: "user",
          content: `Use the whole database for this question. Do not limit yourself to the currently selected port unless the user explicitly narrows the scope.\n\n${question}`,
        },
      ],
    }),
  });

  const raw = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${raw}`);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${parsed.error || raw}`);
  }

  return parsed;
}

async function main() {
  console.log(`Running assistant bunker regression against ${DEFAULT_BASE_URL}`);

  let failures = 0;

  for (const testCase of CASES) {
    try {
      const response = await ask(DEFAULT_BASE_URL, testCase.question);
      const answer = normalize(response.answer);
      const mismatches = [];

      for (const expected of testCase.mustContain || []) {
        if (!answer.includes(normalize(expected))) {
          mismatches.push(`missing "${expected}"`);
        }
      }

      for (const forbidden of testCase.mustNotContain || []) {
        if (answer.includes(normalize(forbidden))) {
          mismatches.push(`unexpected "${forbidden}"`);
        }
      }

      if (Array.isArray(testCase.mustContainOneOf) && testCase.mustContainOneOf.length > 0) {
        const hasOne = testCase.mustContainOneOf.some((expected) =>
          answer.includes(normalize(expected))
        );
        if (!hasOne) {
          mismatches.push(
            `missing any of: ${testCase.mustContainOneOf.map((item) => `"${item}"`).join(", ")}`
          );
        }
      }

      if (mismatches.length > 0) {
        failures++;
        console.error(`FAIL  ${testCase.name}`);
        for (const mismatch of mismatches) {
          console.error(`  - ${mismatch}`);
        }
        console.error(`  - answer: ${response.answer}`);
        continue;
      }

      console.log(`PASS  ${testCase.name}`);
    } catch (error) {
      failures++;
      console.error(`FAIL  ${testCase.name}`);
      console.error(`  - ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} assistant bunker regression case(s) failed.`);
    process.exit(1);
  }

  console.log(`\nAll ${CASES.length} assistant bunker regression cases passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
