export type ParsedOperationalConditions = {
  waterType: ("SW" | "FW" | "Brackish")[];
  densityValues: string[];
  tideTags: string[];
  movementPhase: ("Arrival" | "Departure")[];
  infrastructureTags: ("SPM" | "SBM" | "CBM")[];
  vesselSizeTags: string[];
  datumTags: string[];
  naabsa: boolean;
  mentionedBerths: string[];
};

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

export function parseOperationalConditions(...inputs: Array<string | null | undefined>): ParsedOperationalConditions {
  const text = inputs.filter(Boolean).join(" ");
  const lower = text.toLowerCase();

  const waterType: ParsedOperationalConditions["waterType"] = [];
  if (/\b(sw|salt water)\b/i.test(lower)) waterType.push("SW");
  if (/\b(fw|fresh water)\b/i.test(lower)) waterType.push("FW");
  if (/\bbw\b|\bbrackish\b/i.test(lower)) waterType.push("Brackish");

  const densityValues = unique(
    Array.from(lower.matchAll(/\b(?:density\s*(?:of|=|:)?\s*)?(1\.\d{3})\b/gi))
      .map((match) => match[1])
      .filter(Boolean)
  );

  const tideTags: string[] = [];
  if (/\bzero tide\b|\b0 m tide\b|\bat zero tide\b/i.test(lower)) tideTags.push("Zero tide");
  if (/\bhigh water\b|\bhw\b/i.test(lower)) tideTags.push("HW");
  if (/\blow water\b|\blw\b/i.test(lower)) tideTags.push("LW");
  if (/\+\/-\s*tide|\btide affected\b/i.test(lower)) tideTags.push("Tide affected");
  if (/\bmllw\b/i.test(lower)) tideTags.push("MLLW");
  const minTideFeetMatch = lower.match(/\bminimum\s+(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s+of\s+tide\b/i);
  if (minTideFeetMatch) tideTags.push(`Min tide ${minTideFeetMatch[1]} ft`);
  const minTideMetersMatch = lower.match(/\bminimum\s+(\d+(?:\.\d+)?)\s*m(?:eters?)?\s+of\s+tide\b/i);
  if (minTideMetersMatch) tideTags.push(`Min tide ${minTideMetersMatch[1]} m`);

  const rangeMatch = lower.match(/\b(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*m\b/);
  if (rangeMatch && /\btide\b/i.test(lower)) {
    tideTags.push(`Tide ${rangeMatch[1]}-${rangeMatch[2]} m`);
  }

  const movementPhase: ParsedOperationalConditions["movementPhase"] = [];
  if (/\barrival\b/i.test(lower)) movementPhase.push("Arrival");
  if (/\bdeparture\b/i.test(lower)) movementPhase.push("Departure");

  const infrastructureTags: ParsedOperationalConditions["infrastructureTags"] = [];
  if (/\bspm\b|\bsingle point mooring\b/i.test(lower)) infrastructureTags.push("SPM");
  if (/\bsbm\b|\bsingle buoy mooring\b/i.test(lower)) infrastructureTags.push("SBM");
  if (/\bcbm\b|\bconventional buoy mooring\b/i.test(lower)) infrastructureTags.push("CBM");

  const vesselSizeTags: string[] = [];
  const loaGreaterFeet = lower.match(/\bloa\s*(?:>|>=|greater than|over)\s*(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\b/i);
  if (loaGreaterFeet) vesselSizeTags.push(`LOA > ${loaGreaterFeet[1]} ft`);
  const loaLessEqualFeet = lower.match(/\bloa\s*(?:≤|<=|less than or equal to|up to)\s*(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\b/i);
  if (loaLessEqualFeet) vesselSizeTags.push(`LOA ≤ ${loaLessEqualFeet[1]} ft`);
  const loaLessFeet = lower.match(/\bloa\s*(?:<|less than)\s*(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\b/i);
  if (loaLessFeet) vesselSizeTags.push(`LOA < ${loaLessFeet[1]} ft`);
  const loaGreaterMeters = lower.match(/\bloa\s*(?:>|>=|greater than|over)\s*(\d+(?:\.\d+)?)\s*m(?:eters?)?\b/i);
  if (loaGreaterMeters) vesselSizeTags.push(`LOA > ${loaGreaterMeters[1]} m`);
  const loaLessEqualMeters = lower.match(/\bloa\s*(?:≤|<=|less than or equal to|up to)\s*(\d+(?:\.\d+)?)\s*m(?:eters?)?\b/i);
  if (loaLessEqualMeters) vesselSizeTags.push(`LOA ≤ ${loaLessEqualMeters[1]} m`);

  const datumTags: string[] = [];
  if (/\bmllw\b/i.test(lower)) datumTags.push("MLLW");
  if (/\bmlws\b/i.test(lower)) datumTags.push("MLWS");
  if (/\bchart datum\b/i.test(lower)) datumTags.push("Chart datum");

  const mentionedBerths = unique(
    Array.from(lower.matchAll(/\b(west|east|north|south)\s+berth\b/gi))
      .map((match) => `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()} Berth`)
  );

  return {
    waterType: unique(waterType),
    densityValues,
    tideTags: unique(tideTags),
    movementPhase: unique(movementPhase),
    infrastructureTags: unique(infrastructureTags),
    vesselSizeTags: unique(vesselSizeTags),
    datumTags: unique(datumTags),
    naabsa: /\bnaabsa\b/i.test(lower),
    mentionedBerths,
  };
}

export function conditionTagsFromParsed(parsed: ParsedOperationalConditions): string[] {
  return unique([
    ...parsed.waterType,
    ...parsed.densityValues.map((value) => `Density ${value}`),
    ...parsed.tideTags,
    ...parsed.movementPhase,
    ...parsed.infrastructureTags,
    ...parsed.vesselSizeTags,
    ...parsed.datumTags,
    ...(parsed.naabsa ? ["NAABSA"] : []),
  ]);
}
