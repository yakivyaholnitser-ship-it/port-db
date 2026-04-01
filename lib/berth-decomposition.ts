import { parseOperationalConditions } from "@/lib/condition-parsing";

export type ParsedBerthValue = {
  berthName: string;
  valueText: string;
};

function normalizeBerthName(raw: string) {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bberth\b/i, "Berth")
    .replace(/\bwest\b/i, "West")
    .replace(/\beast\b/i, "East")
    .replace(/\bnorth\b/i, "North")
    .replace(/\bsouth\b/i, "South");
}

function cleanValuePrefix(value: string) {
  return value
    .replace(/^\s*(max(?:imum)?\s+)?draft\b[:\s-]*/i, "")
    .replace(/^\s*(max(?:imum)?\s+)?air\s*draft\b[:\s-]*/i, "")
    .replace(/^\s*(max(?:imum)?\s+)?dwt\b[:\s-]*/i, "")
    .replace(/^\s*[,;]\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseCombinedBerthValues(args: {
  value: string;
  unit?: string | null;
  notes?: string | null;
}): ParsedBerthValue[] {
  const source = [args.value, args.notes].filter(Boolean).join(" ");
  const matches = Array.from(
    source.matchAll(/([^,;]+?)\s*\((west|east|north|south)\s+berth\)/gi)
  );

  if (matches.length < 2) return [];

  return matches
    .map((match) => {
      const valueText = cleanValuePrefix(match[1] ?? "");
      const berthName = normalizeBerthName(`${match[2]} Berth`);
      if (!valueText || !berthName) return null;

      const withUnit =
        args.unit && !new RegExp(`\\b${args.unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(valueText)
          ? `${valueText} ${args.unit}`
          : valueText;

      return {
        berthName,
        valueText: withUnit.trim(),
      } satisfies ParsedBerthValue;
    })
    .filter((item): item is ParsedBerthValue => Boolean(item));
}

export function berthWideConditionTags(...inputs: Array<string | null | undefined>) {
  const parsed = parseOperationalConditions(...inputs);
  return {
    sharedTags: [
      ...parsed.waterType,
      ...parsed.tideTags,
      ...parsed.movementPhase,
      ...(parsed.naabsa ? ["NAABSA"] : []),
    ],
    mentionedBerths: parsed.mentionedBerths,
  };
}
