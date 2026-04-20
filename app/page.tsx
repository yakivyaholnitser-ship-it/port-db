"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import AIAssistant from "./AIAssistant";
import { parseCombinedBerthValues } from "@/lib/berth-decomposition";
import type { DerivedLocationNode } from "@/lib/location-candidates";

const PortsMap = dynamic(() => import("./PortsMap"), { ssr: false });

type PortFact = {
  id: number;
  createdAt: string;
  category: string;
  value: string;
  unit: string | null;
  notes: string | null;
  source: string | null;
  sourceDate: string | null;
  rawSnippet: string | null;
  scope: "PORT" | "TERMINAL" | "BERTH";
  locationLabel: string | null;
  sourceRecordId: number;
};

type Terminal = {
  id: number;
  name: string;
  berths: { id: number; name: string }[];
};

type PortSummary = {
  id: number;
  name: string;
  country: string | null;
  lat: number | null;
  lon: number | null;
  factsCount: number;
  terminalsCount: number;
  standaloneBerthsCount: number;
  conflictCount: number;
};

type PortDetail = {
  id: number;
  name: string;
  country: string | null;
  lat: number | null;
  lon: number | null;
  facts: PortFact[];
  resolvedFacts: {
    key: string;
    category: string;
    scope: "PORT" | "TERMINAL" | "BERTH";
    locationLabel: string;
    summary: string;
    latestEntries: {
      factId: number;
      value: string;
      unit: string | null;
      displayValue: string;
      conditionTags: string[];
      berthBreakdown: {
        berthName: string;
        displayValue: string;
        conditionTags: string[];
      }[];
      notes: string | null;
      sourceName: string | null;
      sourceDate: string | null;
      sourceRecordId: number;
    }[];
    status: "clear" | "multi_observation" | "conflict";
    observationCount: number;
    distinctValueCount: number;
    observations: {
      factId: number;
      value: string;
      unit: string | null;
      displayValue: string;
      conditionTags: string[];
      berthBreakdown: {
        berthName: string;
        displayValue: string;
        conditionTags: string[];
      }[];
      notes: string | null;
      sourceName: string | null;
      sourceDate: string | null;
      sourceRecordId: number;
    }[];
  }[];
  terminals: Terminal[];
  standaloneBerths: { id: number; name: string }[];
  derivedTerminals: DerivedLocationNode[];
};

const CATEGORY_LABELS: Record<string, string> = {
  draft: "Draft",
  discharge_rate: "Discharge Rate",
  load_rate: "Load Rate",
  tide: "Tide",
  outreach: "Crane Outreach",
  equipment: "Equipment",
  gangs: "Gangs",
  shifts: "Shifts",
  cargo: "Cargo",
  restriction: "Restrictions",
  customs: "Customs",
  bunker: "Bunkering",
  cleaning: "Cleaning",
  survey: "Survey",
  ukc: "UKC",
  hatch_height: "Hatch / Topping Height",
  freeboard: "Freeboard",
  trim: "Trim",
  loa: "LOA",
  beam: "Beam",
  dwt: "DWT",
  cost: "Costs",
  displacement: "Displacement",
  density: "Density",
  air_draft: "Air Draft",
  production: "Production",
  sulphur: "Sulphur",
  transit: "Transit",
  distance_ps_to_anchorage: "P/S to Anchorage",
  distance_ps_to_berth: "P/S to Berth",
  other: "Other",
};

const PRIORITY_CATEGORIES = [
  "draft",
  "air_draft",
  "loa",
  "beam",
  "density",
  "tide",
  "ukc",
  "hatch_height",
  "freeboard",
  "trim",
  "outreach",
  "dwt",
  "displacement",
  "restriction",
  "density",
  "load_rate",
  "discharge_rate",
  "gangs",
  "shifts",
  "production",
  "equipment",
  "cargo",
  "transit",
];

function displayCategoryForFact(fact: PortFact) {
  const base = (fact.category || "other").trim().toLowerCase();
  const haystack = [fact.notes, fact.rawSnippet, fact.value].filter(Boolean).join(" ").toLowerCase();

  if (/\bdraft survey\b/.test(haystack) || /\bshore scale\b/.test(haystack)) return "survey";
  if (/\bfreeboard\b/.test(haystack)) return "freeboard";
  if (/\bwlthc\b|\btopping\b|\bgrain capacity\b|\bhatch\b/.test(haystack)) return "hatch_height";
  if (/\bdockage\b|\bpilotage\b|\bdues\b|\btariff\b|\bcosts?\b|\busd\b|\bagency fee\b|\bport charges?\b/.test(haystack)) {
    return "cost";
  }
  if (base !== "other") return base;

  if (/\boutreach\b/.test(haystack)) return "outreach";
  if (/\bdisplacement\b/.test(haystack)) return "displacement";
  if (/\bdeadweight\b/.test(haystack)) return "dwt";
  if (/\bloa\b|\blength overall\b/.test(haystack)) return "loa";
  if (/\bbeam\b/.test(haystack)) return "beam";
  if (/\bdensity\b|\bspecific gravity\b|\bsalinity\b/.test(haystack)) return "density";
  if (/\btide\b|\bmllw\b|\bmlws\b|\bhigh water\b|\blow water\b/.test(haystack)) return "tide";
  if (/\bukc\b|under keel clearance/.test(haystack)) return "ukc";
  if (/\btrim\b/.test(haystack)) return "trim";
  if (/\bdraft\b/.test(haystack)) return "draft";
  if (/\bload rate\b|\bloading rate\b/.test(haystack)) return "load_rate";
  if (/\bdischarge rate\b|\bdischarging rate\b/.test(haystack)) return "discharge_rate";
  if (/\bgangs?\b/.test(haystack)) return "gangs";
  if (/\bshifts?\b/.test(haystack)) return "shifts";

  return base;
}

function formatDate(value: string | null) {
  if (!value) return "Date unknown";
  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "America/Vancouver",
  });
}

function dateInputValueForToday() {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function factDisplayDate(fact: Pick<PortFact, "sourceDate" | "createdAt">) {
  return fact.sourceDate ?? fact.createdAt;
}

function sourceDisplayName(value: string | null) {
  return value?.trim() || "Manual input";
}

function groupedByCategory(facts: PortFact[]) {
  return facts.reduce<Record<string, PortFact[]>>((acc, fact) => {
    const key = displayCategoryForFact(fact) || "other";
    if (!acc[key]) acc[key] = [];
    acc[key].push(fact);
    return acc;
  }, {});
}

function keyForConflict(fact: PortFact) {
  return `${fact.scope}__${fact.locationLabel ?? "port"}__${fact.category}`;
}

function valueForConflict(fact: PortFact) {
  return `${fact.value}${fact.unit ? ` ${fact.unit}` : ""}`.trim();
}

function detectConflictGroups(facts: PortFact[]) {
  const map = new Map<
    string,
    {
      category: string;
      locationLabel: string | null;
      scope: PortFact["scope"];
      facts: PortFact[];
      values: Set<string>;
    }
  >();

  for (const fact of facts) {
    const key = keyForConflict(fact);
    if (!map.has(key)) {
      map.set(key, {
        category: fact.category,
        locationLabel: fact.locationLabel,
        scope: fact.scope,
        facts: [],
        values: new Set<string>(),
      });
    }

    const group = map.get(key)!;
    group.facts.push(fact);
    group.values.add(valueForConflict(fact));
  }

  return Array.from(map.values()).filter(
    (group) => group.category.trim().toLowerCase() !== "other" && group.values.size > 1
  );
}

function badgeTone(count: number) {
  if (count === 0) return "border-[color:var(--line-soft)] bg-[color:rgba(61,107,123,0.16)] text-[color:var(--ink-soft)]";
  if (count < 3) return "border-[color:rgba(211,122,51,0.35)] bg-[color:rgba(211,122,51,0.12)] text-[color:var(--alert)]";
  return "border-[color:rgba(197,79,63,0.4)] bg-[color:rgba(197,79,63,0.14)] text-[color:var(--danger)]";
}

function berthCountLabel(count: number) {
  if (count === 0) return "Terminal-level data only";
  if (count === 1) return "1 berth";
  return `${count} berths`;
}

function isDisplayableStructuredLocation(value: string) {
  const lower = value.toLowerCase().trim();
  if (!lower) return false;

  return !/air draft|cargo holds survey|stability calculation|port state control|grain loading equipment|operational hours|minimum depth|height of tide|tide range|bunker fuel sulphur|bunker fuel sulfur|fuel sulphur|fuel sulfur|where bunkering|transit time|under keel clearance|water density|load rate|discharge rate|maximum beam|maximum length|max draft|at zero tide|cleaning permitted|draft along side|pipes\s*\d|based on 1 gang|-\s*sulphur$|-\s*sulfur$/i.test(
    lower
  );
}

function IngestForm({
  onDone,
}: {
  onDone: (result: { portId: number; portName: string }) => void;
}) {
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [sourceDate, setSourceDate] = useState(dateInputValueForToday);
  const [file, setFile] = useState<File | null>(null);
  const [extractingFile, setExtractingFile] = useState(false);
  const [extractedFileText, setExtractedFileText] = useState("");
  const [showExtractedPreview, setShowExtractedPreview] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [result, setResult] = useState("");

  async function extractFileText(selectedFile: File) {
    const formData = new FormData();
    formData.append("file", selectedFile);

    const res = await fetch("/api/file-to-text", {
      method: "POST",
      body: formData,
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error ?? "Failed to extract text from file.");
    }

    return data as {
      text: string;
      fileName: string;
      mimeType: string;
    };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() && !file) return;
    setStatus("loading");
    setResult("");

    try {
      let finalText = text.trim();

      if (file) {
        let extractedText = extractedFileText;
        if (!extractedText.trim()) {
          setExtractingFile(true);
          const extracted = await extractFileText(file);
          extractedText = extracted.text;
          setExtractedFileText(extracted.text);
          setShowExtractedPreview(true);
        }

        finalText = finalText
          ? `${finalText}\n\n[Extracted from file: ${file.name}]\n${extractedText}`
          : extractedText;
      }

      if (!finalText.trim()) {
        throw new Error("No readable text was found in the uploaded content.");
      }

      const res = await fetch("/api/ingest-v2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: finalText,
          source: source || undefined,
          sourceDate: sourceDate || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");

      setResult(`Logged ${data.factsAdded} facts for ${data.port.name}`);
      setStatus("ok");
      setText("");
      setFile(null);
      setSourceDate(dateInputValueForToday());
      onDone({ portId: data.port.id, portName: data.port.name });
    } catch (err) {
      setResult((err as Error).message);
      setStatus("error");
    } finally {
      setExtractingFile(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <p className="text-[11px] uppercase tracking-[0.34em] text-[color:var(--ink-muted)]">
          New Source Record
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-[color:var(--ink-main)]">
          Add fresh port intelligence
        </h2>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste agent email, draft note, berth restriction, cargo advice, or leave blank and upload PDF/PNG/JPG..."
        rows={8}
        className="w-full rounded-[24px] border border-[color:var(--line-soft)] bg-[color:rgba(9,26,36,0.7)] px-5 py-4 text-sm text-[color:var(--ink-main)] outline-none transition focus:border-[color:var(--accent)]"
      />

      <div className="rounded-[20px] border border-dashed border-[color:var(--line-soft)] bg-[color:rgba(9,26,36,0.52)] px-4 py-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm font-medium text-[color:var(--ink-main)]">
              Attach PDF or image
            </div>
            <div className="mt-1 text-xs text-[color:var(--ink-muted)]">
              PDF, PNG, JPG, JPEG, WEBP. Image text is extracted with AI before ingestion.
            </div>
          </div>
          <label className="inline-flex cursor-pointer items-center justify-center rounded-full border border-[color:var(--line-soft)] px-4 py-2 text-sm text-[color:var(--ink-soft)] transition hover:border-[color:var(--accent)] hover:text-[color:var(--ink-main)]">
            Choose file
            <input
              type="file"
              accept=".pdf,image/png,image/jpeg,image/jpg,image/webp"
              className="sr-only"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setExtractedFileText("");
                setShowExtractedPreview(false);
              }}
            />
          </label>
        </div>
        {file ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="rounded-full border border-[color:rgba(113,194,183,0.24)] bg-[color:rgba(113,194,183,0.08)] px-3 py-1 text-xs text-[color:var(--accent-soft)]">
              {file.name}
            </span>
            <button
              type="button"
              onClick={() => setFile(null)}
              className="rounded-full border border-[color:rgba(197,79,63,0.28)] px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-[color:var(--danger)] transition hover:bg-[color:rgba(197,79,63,0.08)]"
            >
              Remove file
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!file) return;
                setResult("");
                setStatus("idle");
                setExtractingFile(true);
                try {
                  const extracted = await extractFileText(file);
                  setExtractedFileText(extracted.text);
                  setShowExtractedPreview(true);
                } catch (err) {
                  setResult((err as Error).message);
                  setStatus("error");
                } finally {
                  setExtractingFile(false);
                }
              }}
              disabled={extractingFile}
              className="rounded-full border border-[color:var(--line-soft)] px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-[color:var(--ink-soft)] transition hover:border-[color:var(--accent)] hover:text-[color:var(--ink-main)] disabled:opacity-60"
            >
              {extractingFile ? "Reading..." : extractedFileText ? "Refresh preview" : "Preview extraction"}
            </button>
          </div>
        ) : null}
      </div>

      {showExtractedPreview && extractedFileText ? (
        <div className="rounded-[20px] border border-[color:var(--line-soft)] bg-[color:rgba(9,26,36,0.62)] p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-[color:var(--ink-main)]">
                Extracted text preview
              </div>
              <div className="mt-1 text-xs text-[color:var(--ink-muted)]">
                Review this before ingest. You can edit the extracted text directly below.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowExtractedPreview(false)}
              className="rounded-full border border-[color:var(--line-soft)] px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-[color:var(--ink-soft)] transition hover:border-[color:var(--accent)] hover:text-[color:var(--ink-main)]"
            >
              Hide preview
            </button>
          </div>
          <textarea
            value={extractedFileText}
            onChange={(e) => setExtractedFileText(e.target.value)}
            rows={10}
            className="mt-4 w-full rounded-[18px] border border-[color:var(--line-soft)] bg-[color:rgba(6,20,28,0.75)] px-4 py-3 text-sm text-[color:var(--ink-main)] outline-none transition focus:border-[color:var(--accent)]"
          />
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-[1fr_180px]">
        <input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="Source name (GAC, local agent, charterer)"
          className="rounded-[18px] border border-[color:var(--line-soft)] bg-[color:rgba(9,26,36,0.7)] px-4 py-3 text-sm text-[color:var(--ink-main)] outline-none transition focus:border-[color:var(--accent)]"
        />
        <input
          type="date"
          value={sourceDate}
          onChange={(e) => setSourceDate(e.target.value)}
          className="rounded-[18px] border border-[color:var(--line-soft)] bg-[color:rgba(9,26,36,0.7)] px-4 py-3 text-sm text-[color:var(--ink-main)] outline-none transition focus:border-[color:var(--accent)]"
        />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          type="submit"
          disabled={status === "loading" || extractingFile}
          className="inline-flex items-center justify-center rounded-full bg-[color:var(--accent)] px-5 py-3 text-sm font-semibold text-[color:#06202b] transition hover:brightness-110 disabled:opacity-60"
        >
          {extractingFile
            ? "Reading file..."
            : status === "loading"
              ? "Classifying..."
              : "Ingest source"}
        </button>
        {result ? (
          <div
            className={`rounded-full border px-4 py-2 text-sm ${
              status === "ok"
                ? "border-[color:rgba(113,194,183,0.32)] bg-[color:rgba(113,194,183,0.12)] text-[color:var(--accent-soft)]"
                : "border-[color:rgba(197,79,63,0.32)] bg-[color:rgba(197,79,63,0.12)] text-[color:var(--danger)]"
            }`}
          >
            {result}
          </div>
        ) : null}
      </div>
    </form>
  );
}

function FactCard({
  fact,
  isLatest,
  onDelete,
}: {
  fact: PortFact;
  isLatest?: boolean;
  onDelete: (fact: PortFact) => void;
}) {
  return (
    <article className="rounded-[22px] border border-[color:var(--line-soft)] bg-[color:rgba(10,34,45,0.72)] p-4 shadow-[0_18px_40px_rgba(1,9,14,0.18)]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-[color:rgba(113,194,183,0.28)] bg-[color:rgba(113,194,183,0.09)] px-2.5 py-1 text-[10px] uppercase tracking-[0.22em] text-[color:var(--accent-soft)]">
            {fact.scope}
          </span>
          {isLatest ? (
            <span className="rounded-full border border-[color:rgba(113,194,183,0.24)] bg-[color:rgba(113,194,183,0.1)] px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-[color:var(--accent-soft)]">
              Latest
            </span>
          ) : null}
          {fact.locationLabel ? (
            <span className="text-xs uppercase tracking-[0.2em] text-[color:var(--ink-muted)]">
              {fact.locationLabel}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => onDelete(fact)}
          className="rounded-full border border-[color:rgba(197,79,63,0.28)] px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-[color:var(--danger)] transition hover:bg-[color:rgba(197,79,63,0.08)]"
        >
          Delete
        </button>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <div className="text-lg font-semibold text-[color:var(--ink-main)]">
          {fact.value}
        </div>
        {fact.unit ? (
          <div className="text-sm text-[color:var(--ink-soft)]">{fact.unit}</div>
        ) : null}
      </div>
      {fact.notes ? (
        <p className="mt-2 text-sm leading-6 text-[color:var(--ink-soft)]">{fact.notes}</p>
      ) : null}
      <div className="mt-4 text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
        {sourceDisplayName(fact.source)} · {formatDate(factDisplayDate(fact))}
      </div>
    </article>
  );
}

function EvidenceTable({
  facts,
  latestFactId,
  onDelete,
}: {
  facts: PortFact[];
  latestFactId?: number | null;
  onDelete: (fact: PortFact) => void;
}) {
  return (
    <div className="space-y-3">
      {facts.map((fact) => (
        <article
          key={fact.id}
          className="rounded-[20px] border border-[color:var(--line-soft)] bg-[color:rgba(9,26,36,0.74)] p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-[color:rgba(113,194,183,0.22)] bg-[color:rgba(113,194,183,0.08)] px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-[color:var(--accent-soft)]">
                  {fact.scope}
                </span>
                {latestFactId === fact.id ? (
                  <span className="rounded-full border border-[color:rgba(113,194,183,0.24)] bg-[color:rgba(113,194,183,0.1)] px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-[color:var(--accent-soft)]">
                    Latest
                  </span>
                ) : null}
                {fact.locationLabel ? (
                  <span className="text-[10px] uppercase tracking-[0.16em] text-[color:var(--ink-muted)]">
                    {fact.locationLabel}
                  </span>
                ) : null}
              </div>
              <div className="mt-3 text-sm font-semibold leading-6 text-[color:var(--ink-main)] break-words">
                {fact.value}
                {fact.unit ? ` ${fact.unit}` : ""}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onDelete(fact)}
              className="shrink-0 rounded-full border border-[color:rgba(197,79,63,0.28)] px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-[color:var(--danger)] transition hover:bg-[color:rgba(197,79,63,0.08)]"
            >
              Delete
            </button>
          </div>

          {fact.notes ? (
            <p className="mt-3 text-sm leading-6 text-[color:var(--ink-soft)] break-words">
              {fact.notes}
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2">
            <span className="rounded-full border border-[color:var(--line-soft)] px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-[color:var(--ink-soft)]">
              {sourceDisplayName(fact.source)}
            </span>
            <span className="rounded-full border border-[color:var(--line-soft)] px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-[color:var(--ink-soft)]">
              {formatDate(factDisplayDate(fact))}
            </span>
          </div>
        </article>
      ))}
    </div>
  );
}

export default function PortsPage() {
  const [ports, setPorts] = useState<PortSummary[]>([]);
  const [selectedPort, setSelectedPort] = useState<PortDetail | null>(null);
  const [search, setSearch] = useState("");
  const [selectedPortId, setSelectedPortId] = useState<number | null>(null);
  const [selectedTerminalName, setSelectedTerminalName] = useState<string | null>(null);
  const [selectedBerthName, setSelectedBerthName] = useState<string | null>(null);
  const [expandedCategoryKeys, setExpandedCategoryKeys] = useState<string[]>([]);
  const [showIngest, setShowIngest] = useState(false);
  const [showAllPorts, setShowAllPorts] = useState(false);
  const [highlightedPorts, setHighlightedPorts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function fetchPorts(options?: {
    focusPortId?: number | null;
    focusPortName?: string | null;
    refreshDetail?: boolean;
  }) {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/ports-v2");
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof data?.error === "string" ? data.error : "Failed to load port ledger."
        );
      }

      if (!Array.isArray(data)) {
        throw new Error("Unexpected response shape from /api/ports-v2.");
      }

      setPorts(data);
      const currentSelectedPortId = selectedPortId;
      const nextSelectedPortId = ((prev: number | null) => {
        const requestedById =
          options?.focusPortId != null
            ? data.find((port) => port.id === options.focusPortId)?.id ?? null
            : null;

        const requestedByName =
          options?.focusPortName != null
            ? data.find(
                (port) =>
                  port.name.toLowerCase() === options.focusPortName?.toLowerCase()
              )?.id ?? null
            : null;

        return requestedById ?? requestedByName ?? prev ?? data[0]?.id ?? null;
      })(selectedPortId);

      setSelectedPortId(nextSelectedPortId);
      if (options?.refreshDetail && nextSelectedPortId != null && nextSelectedPortId === currentSelectedPortId) {
        await fetchPortDetail(nextSelectedPortId);
      }
    } catch (error) {
      setPorts([]);
      setSelectedPortId(null);
      setSelectedPort(null);
      setLoadError(error instanceof Error ? error.message : "Failed to load port ledger.");
    } finally {
      setLoading(false);
    }
  }

  async function fetchPortDetail(portId: number) {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/ports-v2?portId=${portId}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof data?.error === "string" ? data.error : "Failed to load port details."
        );
      }
      setLoadError(null);
      setSelectedPort(data);
    } catch (error) {
      setSelectedPort(null);
      setLoadError(error instanceof Error ? error.message : "Failed to load port details.");
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    // Initial page load fetches only lightweight port summaries.
    fetchPorts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setExpandedCategoryKeys([]);
    setSelectedTerminalName(null);
    setSelectedBerthName(null);
  }, [selectedPortId]);

  useEffect(() => {
    if (selectedPortId == null) {
      setSelectedPort(null);
      return;
    }
    fetchPortDetail(selectedPortId);
  }, [selectedPortId]);

  function matchesTerminalFocus(locationLabel: string | null, terminalName: string) {
    if (!locationLabel) return false;
    return (
      locationLabel === terminalName ||
      locationLabel.startsWith(`${terminalName} /`)
    );
  }

  function matchesBerthFocus(locationLabel: string | null, terminalName: string, berthName: string) {
    if (!locationLabel) return false;
    return locationLabel === `${terminalName} / ${berthName}`;
  }

  function matchesStandaloneBerthFocus(locationLabel: string | null, berthName: string) {
    if (!locationLabel) return false;
    return locationLabel === berthName;
  }

  function factMentionsBerth(fact: PortFact, berthName: string) {
    return parseCombinedBerthValues({
      value: fact.value,
      unit: fact.unit,
      notes: fact.notes,
    }).some((part) => part.berthName === berthName);
  }

  const filteredPorts = useMemo(
    () =>
      ports.filter((port) => {
        const haystack = `${port.name} ${port.country ?? ""}`.toLowerCase();
        return haystack.includes(search.toLowerCase());
      }),
    [ports, search]
  );

  const visiblePorts = useMemo(() => {
    if (showAllPorts || search.trim()) return filteredPorts;
    return filteredPorts.slice(0, 8);
  }, [filteredPorts, search, showAllPorts]);

  const selectedPortSummary =
    filteredPorts.find((port) => port.id === selectedPortId) ??
    ports.find((port) => port.id === selectedPortId) ??
    null;

  const selectedFacts = useMemo(() => {
    const facts = selectedPort?.facts ?? [];
    if (selectedTerminalName && selectedBerthName) {
      return facts.filter((fact) =>
        matchesBerthFocus(fact.locationLabel, selectedTerminalName, selectedBerthName) ||
        (matchesTerminalFocus(fact.locationLabel, selectedTerminalName) &&
          factMentionsBerth(fact, selectedBerthName))
      );
    }
    if (!selectedTerminalName && selectedBerthName) {
      return facts.filter((fact) =>
        matchesStandaloneBerthFocus(fact.locationLabel, selectedBerthName)
      );
    }
    if (!selectedTerminalName) return facts;
    return facts.filter((fact) => matchesTerminalFocus(fact.locationLabel, selectedTerminalName));
  }, [selectedPort, selectedTerminalName, selectedBerthName]);
  const visibleSelectedTerminals = useMemo(
    () =>
      (selectedPort?.terminals ?? []).filter(
        (terminal) => isDisplayableStructuredLocation(terminal.name)
      ),
    [selectedPort]
  );
  const visibleStandaloneBerths = useMemo(
    () =>
      (selectedPort?.standaloneBerths ?? []).filter(
        (berth) => isDisplayableStructuredLocation(berth.name)
      ),
    [selectedPort]
  );
  const derivedTerminalStack = useMemo<DerivedLocationNode[]>(
    () => selectedPort?.derivedTerminals ?? [],
    [selectedPort]
  );

  const groupedFacts = groupedByCategory(selectedFacts);
  const hasNarrowFocus = Boolean(selectedTerminalName || selectedBerthName);
  const orderedCategories = Object.keys(groupedFacts).sort((a, b) => {
    const aIndex = PRIORITY_CATEGORIES.indexOf(a);
    const bIndex = PRIORITY_CATEGORIES.indexOf(b);
    if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  });

  const conflictGroups = detectConflictGroups(selectedFacts);
  const sourceMoments = Array.from(
    new Map(
      selectedFacts.map((fact) => [
        `${fact.sourceRecordId}`,
        {
          sourceRecordId: fact.sourceRecordId,
          source: sourceDisplayName(fact.source),
          sourceDate: factDisplayDate(fact),
          label: fact.locationLabel ?? selectedPort?.name ?? "Port",
        },
      ])
    ).values()
  ).sort((a, b) => {
    const aTime = a.sourceDate ? new Date(a.sourceDate).getTime() : 0;
    const bTime = b.sourceDate ? new Date(b.sourceDate).getTime() : 0;
    return bTime - aTime;
  });

  const stats = {
    ports: ports.length,
    facts: ports.reduce((sum, port) => sum + port.factsCount, 0),
    conflicts: ports.reduce((sum, port) => sum + port.conflictCount, 0),
    terminals: ports.reduce((sum, port) => sum + port.terminalsCount, 0),
  };

  const mapEntries = ports
    .filter((port) => port.lat != null && port.lon != null)
    .map((port) => ({
      id: port.id,
      port: port.name,
      country: port.country,
      terminal: "",
      operation: "",
      lat: port.lat,
      lon: port.lon,
    }));

  async function handleDeletePort() {
    if (!selectedPort) return;
    if (!confirm(`Delete port "${selectedPort.name}" and all its data?`)) return;
    const res = await fetch(`/api/ports/${selectedPort.id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(typeof data?.error === "string" ? data.error : "Failed to delete port.");
      return;
    }
    setSelectedPortId(null);
    await fetchPorts({ refreshDetail: true });
  }

  async function handleDeletePortById(portId: number, portName: string) {
    if (!confirm(`Delete port "${portName}" and all its data?`)) return;
    const res = await fetch(`/api/ports/${portId}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(typeof data?.error === "string" ? data.error : "Failed to delete port.");
      return;
    }
    if (selectedPortId === portId) {
      setSelectedPortId(null);
    }
    await fetchPorts({ refreshDetail: true });
  }

  async function handleDeleteTerminal(terminalId: number, terminalName: string) {
    if (!confirm(`Delete terminal "${terminalName}" and all linked berth-level data?`)) return;
    const res = await fetch(`/api/terminals/${terminalId}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(typeof data?.error === "string" ? data.error : "Failed to delete terminal.");
      return;
    }
    setSelectedTerminalName((current) => (current === terminalName ? null : current));
    setSelectedBerthName(null);
    await fetchPorts({ focusPortId: selectedPortId, refreshDetail: true });
  }

  async function handleDeleteBerth(berthId: number, berthName: string) {
    if (!confirm(`Delete berth "${berthName}" and all linked data?`)) return;
    const res = await fetch(`/api/berths/${berthId}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(typeof data?.error === "string" ? data.error : "Failed to delete berth.");
      return;
    }
    setSelectedBerthName((current) => (current === berthName ? null : current));
    await fetchPorts({ focusPortId: selectedPortId, refreshDetail: true });
  }

  async function handleDeleteFact(
    fact: Pick<PortFact, "id" | "category" | "value" | "locationLabel">
  ) {
    const factLabel = `${CATEGORY_LABELS[fact.category] ?? fact.category}: ${fact.value}`;
    const locationPart = fact.locationLabel ? ` from ${fact.locationLabel}` : "";
    if (!confirm(`Delete fact "${factLabel}"${locationPart}?`)) return;

    const res = await fetch(`/api/facts/${fact.id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(typeof data?.error === "string" ? data.error : "Failed to delete fact.");
      return;
    }

    await fetchPorts({ focusPortId: selectedPortId, refreshDetail: true });
  }

  function toggleCategoryExpansion(category: string) {
    setExpandedCategoryKeys((current) =>
      current.includes(category)
        ? current.filter((item) => item !== category)
        : [...current, category]
    );
  }

  function toggleTerminalFocus(terminalName: string) {
    setSelectedTerminalName((current) => {
      const next = current === terminalName ? null : terminalName;
      setSelectedBerthName(null);
      return next;
    });
  }

  function focusTerminalFromMap(portId: number, terminalName: string) {
    setSelectedPortId(portId);
    setSelectedTerminalName(terminalName);
    setSelectedBerthName(null);
  }

  function focusBerthFromMap(portId: number, terminalName: string, berthName: string) {
    setSelectedPortId(portId);
    setSelectedTerminalName(terminalName);
    setSelectedBerthName(berthName);
  }

  function toggleBerthFocus(terminalName: string, berthName: string) {
    setSelectedTerminalName(terminalName);
    setSelectedBerthName((current) =>
      current === berthName && selectedTerminalName === terminalName ? null : berthName
    );
  }

  return (
    <div className="min-h-screen bg-[color:var(--base)] text-[color:var(--ink-main)]">
      <div className="pointer-events-none fixed inset-0 opacity-70">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(113,194,183,0.14),transparent_30%),radial-gradient(circle_at_top_right,rgba(211,122,51,0.14),transparent_24%),linear-gradient(180deg,rgba(4,19,28,0.96),rgba(5,14,21,1))]" />
        <div className="absolute inset-x-0 top-0 h-40 bg-[linear-gradient(90deg,transparent,rgba(113,194,183,0.08),transparent)]" />
      </div>

      <div className="relative mx-auto max-w-[1680px] px-4 py-4 lg:px-6">
        <header className="overflow-hidden rounded-[32px] border border-[color:var(--line-strong)] bg-[color:rgba(8,28,39,0.82)] shadow-[0_24px_80px_rgba(2,8,12,0.36)]">
          <div className="grid gap-6 px-6 py-6 lg:grid-cols-[1.35fr_0.9fr] lg:px-8 lg:py-7">
            <div>
              <p className="text-[11px] uppercase tracking-[0.38em] text-[color:var(--ink-muted)]">
                Port Intelligence Console
              </p>
              <h1 className="mt-3 max-w-3xl font-serif text-4xl leading-tight text-[color:var(--ink-main)] lg:text-5xl">
                Operational evidence, value variation, and berth-level truth in one view.
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-[color:var(--ink-soft)] lg:text-[15px]">
                Structure free-form port messages into a live intelligence ledger, keep every source,
                and let AI explain where the draft, density, gangs, or restrictions disagree.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-[24px] border border-[color:var(--line-soft)] bg-[color:rgba(7,24,32,0.82)] p-4">
                <div className="text-[11px] uppercase tracking-[0.24em] text-[color:var(--ink-muted)]">Tracked Ports</div>
                <div className="mt-3 text-3xl font-semibold text-[color:var(--accent-soft)]">{stats.ports}</div>
                <div className="mt-2 text-sm text-[color:var(--ink-soft)]">with {stats.terminals} terminals attached</div>
              </div>
              <div className="rounded-[24px] border border-[color:var(--line-soft)] bg-[color:rgba(7,24,32,0.82)] p-4">
                <div className="text-[11px] uppercase tracking-[0.24em] text-[color:var(--ink-muted)]">Fact Ledger</div>
                <div className="mt-3 text-3xl font-semibold text-[color:var(--harbor)]">{stats.facts}</div>
                <div className="mt-2 text-sm text-[color:var(--ink-soft)]">historical facts across all scopes</div>
              </div>
              <div className={`rounded-[24px] border p-4 ${badgeTone(stats.conflicts)}`}>
                <div className="text-[11px] uppercase tracking-[0.24em]">Value Variation</div>
                <div className="mt-3 text-3xl font-semibold">{stats.conflicts}</div>
                <div className="mt-2 text-sm">categories with competing values</div>
              </div>
              <button
                onClick={() => setShowIngest(true)}
                className="rounded-[24px] border border-[color:rgba(113,194,183,0.28)] bg-[linear-gradient(135deg,rgba(113,194,183,0.2),rgba(45,86,104,0.2))] p-4 text-left transition hover:border-[color:rgba(113,194,183,0.48)] hover:bg-[linear-gradient(135deg,rgba(113,194,183,0.28),rgba(45,86,104,0.22))]"
              >
                <div className="text-[11px] uppercase tracking-[0.24em] text-[color:var(--ink-muted)]">New Source</div>
                <div className="mt-3 text-xl font-semibold text-[color:var(--ink-main)]">Ingest manual input</div>
                <div className="mt-2 text-sm text-[color:var(--ink-soft)]">
                  Paste agent emails, berth advisories, draft notes, or cargo restrictions.
                </div>
              </button>
              <Link
                href="/review"
                className="rounded-[24px] border border-[color:rgba(211,122,51,0.24)] bg-[linear-gradient(135deg,rgba(211,122,51,0.16),rgba(16,45,57,0.22))] p-4 text-left transition hover:border-[color:rgba(211,122,51,0.4)] hover:bg-[linear-gradient(135deg,rgba(211,122,51,0.22),rgba(16,45,57,0.28))]"
              >
                <div className="text-[11px] uppercase tracking-[0.24em] text-[color:var(--ink-muted)]">Review Queue</div>
                <div className="mt-3 text-xl font-semibold text-[color:var(--ink-main)]">Inspect AI matches</div>
                <div className="mt-2 text-sm text-[color:var(--ink-soft)]">
                  Check ambiguous terminal and berth resolutions before they spread.
                </div>
              </Link>
            </div>
          </div>
        </header>

        <div className="mt-4 grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="overflow-hidden rounded-[28px] border border-[color:var(--line-strong)] bg-[color:rgba(8,24,33,0.82)]">
            <div className="border-b border-[color:var(--line-soft)] px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.28em] text-[color:var(--ink-muted)]">
                    Navigator
                  </div>
                  <h2 className="mt-2 text-xl font-semibold text-[color:var(--ink-main)]">Ports & terminals</h2>
                </div>
                <div className="rounded-full border border-[color:var(--line-soft)] px-3 py-1 text-xs text-[color:var(--ink-soft)]">
                  {filteredPorts.length}
                </div>
              </div>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search port or country..."
                className="mt-4 w-full rounded-full border border-[color:var(--line-soft)] bg-[color:rgba(7,20,28,0.9)] px-4 py-3 text-sm text-[color:var(--ink-main)] outline-none transition focus:border-[color:var(--accent)]"
              />
              {!loading && !loadError && filteredPorts.length > 8 && !search.trim() ? (
                <div className="mt-4 flex items-center justify-between gap-3">
                  <div className="text-xs text-[color:var(--ink-soft)]">
                    Showing {visiblePorts.length} of {filteredPorts.length} ports
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowAllPorts((prev) => !prev)}
                    className="rounded-full border border-[color:var(--line-soft)] px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-[color:var(--accent-soft)] transition hover:border-[color:rgba(113,194,183,0.42)]"
                  >
                    {showAllPorts ? "Show Less" : "See All"}
                  </button>
                </div>
              ) : null}
            </div>

            <div className="max-h-[calc(100vh-280px)] overflow-y-auto px-3 py-3">
              {loading ? (
                <div className="px-3 py-4 text-sm text-[color:var(--ink-soft)]">Loading ledger...</div>
              ) : loadError ? (
                <div className="rounded-[22px] border border-[color:rgba(197,79,63,0.3)] bg-[color:rgba(197,79,63,0.08)] px-4 py-4 text-sm text-[color:var(--danger)]">
                  {loadError}
                </div>
              ) : filteredPorts.length === 0 ? (
                <div className="px-3 py-4 text-sm text-[color:var(--ink-soft)]">No matching ports yet.</div>
              ) : (
                visiblePorts.map((port) => {
                  const portConflicts = port.conflictCount;
                  const isActive = selectedPortId === port.id;

                  return (
                    <div
                      key={port.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedPortId(port.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedPortId(port.id);
                        }
                      }}
                      className={`mb-2 w-full cursor-pointer rounded-[22px] border px-4 py-4 text-left transition ${
                        isActive
                          ? "border-[color:rgba(113,194,183,0.42)] bg-[color:rgba(24,64,74,0.72)] shadow-[0_16px_40px_rgba(0,0,0,0.18)]"
                          : "border-[color:var(--line-soft)] bg-[color:rgba(8,25,34,0.7)] hover:border-[color:rgba(113,194,183,0.28)] hover:bg-[color:rgba(13,35,45,0.78)]"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-base font-semibold text-[color:var(--ink-main)]">{port.name}</div>
                          <div className="mt-1 text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
                            {port.country || "Country unknown"}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] ${badgeTone(portConflicts)}`}>
                            {portConflicts === 0 ? "stable" : `${portConflicts} variations`}
                          </span>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleDeletePortById(port.id, port.name);
                            }}
                            className="rounded-full border border-[color:rgba(197,79,63,0.28)] px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-[color:var(--danger)] transition hover:bg-[color:rgba(197,79,63,0.08)]"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2 text-xs text-[color:var(--ink-soft)]">
                        <span>{port.factsCount} facts</span>
                        <span>{port.terminalsCount} terminals</span>
                        <span>{port.standaloneBerthsCount} standalone berths</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="border-t border-[color:var(--line-soft)] px-5 py-4">
              <div className="text-[11px] uppercase tracking-[0.28em] text-[color:var(--ink-muted)]">Recent evidence</div>
              <div className="mt-4 space-y-3">
                {!selectedPort && detailLoading ? (
                  <p className="text-sm text-[color:var(--ink-soft)]">Loading recent evidence...</p>
                ) : !selectedPort ? (
                  <p className="text-sm text-[color:var(--ink-soft)]">Select a port to inspect recent evidence.</p>
                ) : sourceMoments.length === 0 ? (
                  <p className="text-sm text-[color:var(--ink-soft)]">No source records yet for this port.</p>
                ) : (
                  sourceMoments.slice(0, 8).map((item) => (
                    <div
                      key={item.sourceRecordId}
                      className="rounded-[18px] border border-[color:var(--line-soft)] bg-[color:rgba(7,24,32,0.74)] p-3"
                    >
                      <div className="text-sm font-semibold text-[color:var(--ink-main)]">{item.source}</div>
                      <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-[color:var(--ink-muted)]">
                        {item.label} · {formatDate(item.sourceDate)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </aside>

          <main className="space-y-4">
            <section className="overflow-hidden rounded-[30px] border border-[color:var(--line-strong)] bg-[color:rgba(8,28,39,0.84)]">
              <div className="mt-5 rounded-[28px] bg-[color:rgba(8,24,33,0.82)] p-5">
                <div className="text-[11px] uppercase tracking-[0.28em] text-[color:var(--ink-muted)]">AI Analyst</div>
                <div className="mt-2 max-w-2xl text-sm leading-7 text-[color:var(--ink-soft)]">
                  Ask about draft margins, berth restrictions, density assumptions, or compare sources for the selected port and its terminals.
                </div>
                <div className="mt-5">
                  <AIAssistant
                    ports={ports.map((port) => ({
                      id: port.id,
                      name: port.name,
                      country: port.country,
                    }))}
                    initialPortId={selectedPortId}
                    onHighlightPorts={setHighlightedPorts}
                    onOpenPort={(portName, portCountry) => {
                      const matched = ports.find(
                        (port) =>
                          port.name.toLowerCase() === portName.toLowerCase() &&
                          (!portCountry || (port.country ?? "").toLowerCase() === portCountry.toLowerCase())
                      ) ?? ports.find(
                        (port) => port.name.toLowerCase() === portName.toLowerCase()
                      );
                      if (matched) {
                        setSelectedPortId(matched.id);
                        setSelectedTerminalName(null);
                        setSelectedBerthName(null);
                      }
                    }}
                    onOpenLocation={({ portName, portCountry, terminalName, berthName }) => {
                      const matched = ports.find(
                        (port) =>
                          port.name.toLowerCase() === portName.toLowerCase() &&
                          (!portCountry || (port.country ?? "").toLowerCase() === portCountry.toLowerCase())
                      ) ?? ports.find(
                        (port) => port.name.toLowerCase() === portName.toLowerCase()
                      );
                      if (!matched) return;
                      setSelectedPortId(matched.id);
                      setSelectedTerminalName(terminalName ?? null);
                      setSelectedBerthName(berthName ?? null);
                    }}
                  />
                </div>
              </div>

              <div className="mt-5 grid gap-4 border-b border-[color:var(--line-soft)] px-5 py-5 lg:grid-cols-[1.1fr_0.9fr] lg:px-6">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.34em] text-[color:var(--ink-muted)]">Selected dossier</div>
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <h2 className="font-serif text-3xl text-[color:var(--ink-main)]">
                      {selectedPort?.name || selectedPortSummary?.name || "No port selected"}
                    </h2>
                    {(selectedPort?.country ?? selectedPortSummary?.country) ? (
                      <div className="text-sm uppercase tracking-[0.2em] text-[color:var(--ink-muted)]">
                        {selectedPort?.country ?? selectedPortSummary?.country}
                      </div>
                    ) : null}
                  </div>
                  <p className="mt-3 max-w-2xl text-sm leading-7 text-[color:var(--ink-soft)]">
                    See terminal structure, evidence by category, and every operational datapoint with its source trail.
                  </p>
                  {selectedTerminalName || selectedBerthName ? (
                    <div className="mt-4 flex items-center gap-3">
                      {selectedTerminalName ? (
                        <div className="rounded-full border border-[color:rgba(113,194,183,0.28)] bg-[color:rgba(113,194,183,0.08)] px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-[color:var(--accent-soft)]">
                          Terminal focus: {selectedTerminalName}
                        </div>
                      ) : null}
                      {selectedBerthName ? (
                        <div className="rounded-full border border-[color:rgba(124,150,196,0.24)] bg-[color:rgba(124,150,196,0.1)] px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-[color:#b9c7ef]">
                          Berth focus: {selectedBerthName}
                        </div>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedTerminalName(null);
                          setSelectedBerthName(null);
                        }}
                        className="rounded-full border border-[color:var(--line-soft)] px-3 py-1.5 text-xs uppercase tracking-[0.16em] text-[color:var(--ink-soft)] transition hover:border-[color:rgba(113,194,183,0.28)] hover:text-[color:var(--accent-soft)]"
                      >
                        Clear focus
                      </button>
                    </div>
                  ) : null}
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-[22px] border border-[color:var(--line-soft)] bg-[color:rgba(7,24,32,0.8)] p-4">
                    <div className="text-[11px] uppercase tracking-[0.2em] text-[color:var(--ink-muted)]">Facts</div>
                    <div className="mt-2 text-2xl font-semibold text-[color:var(--ink-main)]">{selectedFacts.length}</div>
                  </div>
                  <div className="rounded-[22px] border border-[color:var(--line-soft)] bg-[color:rgba(7,24,32,0.8)] p-4">
                    <div className="text-[11px] uppercase tracking-[0.2em] text-[color:var(--ink-muted)]">Sources</div>
                    <div className="mt-2 text-2xl font-semibold text-[color:var(--ink-main)]">{sourceMoments.length}</div>
                  </div>
                  <div className={`rounded-[22px] border p-4 ${badgeTone(conflictGroups.length)}`}>
                    <div className="text-[11px] uppercase tracking-[0.2em]">Variations</div>
                    <div className="mt-2 text-2xl font-semibold">{conflictGroups.length}</div>
                  </div>
                </div>
              </div>

              <div className="h-[350px] overflow-hidden px-4 py-4 lg:px-5">
                <PortsMap
                  entries={mapEntries}
                  highlightedPorts={highlightedPorts}
                  selectedPortId={selectedPortId}
                  selectedPortStructure={visibleSelectedTerminals.map((terminal) => ({
                    name: terminal.name,
                    berths: terminal.berths.map((berth) => berth.name),
                  }))}
                  onSelectPort={(portId) => setSelectedPortId(portId)}
                  onSelectTerminal={(terminalName) => {
                    if (selectedPortId != null) {
                      focusTerminalFromMap(selectedPortId, terminalName);
                    }
                  }}
                  onSelectBerth={(terminalName, berthName) => {
                    if (selectedPortId != null) {
                      focusBerthFromMap(selectedPortId, terminalName, berthName);
                    }
                  }}
                />
              </div>
            </section>

            <section className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
              <div className="rounded-[28px] border border-[color:var(--line-strong)] bg-[color:rgba(8,24,33,0.82)] p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.28em] text-[color:var(--ink-muted)]">Structure</div>
                    <h3 className="mt-2 text-xl font-semibold text-[color:var(--ink-main)]">Terminal stack</h3>
                  </div>
                  {selectedPort ? (
                    <button
                      onClick={handleDeletePort}
                      className="rounded-full border border-[color:rgba(197,79,63,0.28)] px-3 py-2 text-xs uppercase tracking-[0.18em] text-[color:var(--danger)] transition hover:bg-[color:rgba(197,79,63,0.08)]"
                    >
                      Delete port
                    </button>
                  ) : null}
                </div>

                {!selectedPort && detailLoading ? (
                  <p className="mt-6 text-sm text-[color:var(--ink-soft)]">Loading structure...</p>
                ) : !selectedPort ? (
                  <p className="mt-6 text-sm text-[color:var(--ink-soft)]">Select a port to inspect its structure.</p>
                ) : (
                  <div className="mt-5 space-y-3">
                    {visibleSelectedTerminals.length === 0 &&
                    visibleStandaloneBerths.length === 0 &&
                    derivedTerminalStack.length === 0 ? (
                      <p className="text-sm text-[color:var(--ink-soft)]">No terminals or berths linked yet.</p>
                    ) : null}

                    {visibleSelectedTerminals.map((terminal) => (
                      <div
                        key={terminal.id}
                        className={`rounded-[22px] border p-4 transition ${
                          selectedTerminalName === terminal.name
                            ? "border-[color:rgba(113,194,183,0.32)] bg-[color:rgba(20,52,64,0.82)]"
                            : "border-[color:var(--line-soft)] bg-[color:rgba(7,24,32,0.74)]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[11px] uppercase tracking-[0.22em] text-[color:var(--ink-muted)]">Terminal</div>
                            <div className="mt-1 text-lg font-semibold text-[color:var(--ink-main)]">{terminal.name}</div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => toggleTerminalFocus(terminal.name)}
                              className="rounded-full border border-[color:rgba(113,194,183,0.2)] px-3 py-1 text-xs uppercase tracking-[0.16em] text-[color:var(--accent-soft)] transition hover:bg-[color:rgba(113,194,183,0.08)]"
                            >
                              {selectedTerminalName === terminal.name ? "Showing" : "Show facts"}
                            </button>
                            <div className="rounded-full border border-[color:var(--line-soft)] px-3 py-1 text-xs text-[color:var(--ink-soft)]">
                              {berthCountLabel(terminal.berths.length)}
                            </div>
                            <button
                              type="button"
                              onClick={() => handleDeleteTerminal(terminal.id, terminal.name)}
                              className="rounded-full border border-[color:rgba(197,79,63,0.28)] px-3 py-1 text-xs uppercase tracking-[0.16em] text-[color:var(--danger)] transition hover:bg-[color:rgba(197,79,63,0.08)]"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                        {terminal.berths.length > 0 ? (
                          <div className="mt-4 flex flex-wrap gap-2">
                            {terminal.berths.map((berth) => (
                              <div
                                key={berth.id}
                                className="flex items-center gap-2 rounded-full border border-[color:rgba(113,194,183,0.2)] bg-[color:rgba(113,194,183,0.06)] px-3 py-1.5 text-xs uppercase tracking-[0.16em] text-[color:var(--accent-soft)]"
                              >
                                <button
                                  type="button"
                                  onClick={() => toggleBerthFocus(terminal.name, berth.name)}
                                  className="text-left"
                                >
                                  {berth.name}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteBerth(berth.id, berth.name)}
                                  className="rounded-full border border-[color:rgba(197,79,63,0.28)] px-2 py-0.5 text-[10px] tracking-[0.12em] text-[color:var(--danger)] transition hover:bg-[color:rgba(197,79,63,0.08)]"
                                >
                                  x
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}

                    {derivedTerminalStack.map((terminal) => (
                      <div
                        key={terminal.id}
                        className={`rounded-[22px] border p-4 transition ${
                          selectedTerminalName === terminal.name
                            ? "border-[color:rgba(113,194,183,0.32)] bg-[color:rgba(20,52,64,0.82)]"
                            : "border-[color:rgba(113,194,183,0.18)] bg-[color:rgba(7,24,32,0.74)]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[11px] uppercase tracking-[0.22em] text-[color:var(--ink-muted)]">
                              Derived Terminal
                            </div>
                            <div className="mt-1 text-lg font-semibold text-[color:var(--ink-main)]">
                              {terminal.name}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => toggleTerminalFocus(terminal.name)}
                              className="rounded-full border border-[color:rgba(113,194,183,0.2)] px-3 py-1 text-xs uppercase tracking-[0.16em] text-[color:var(--accent-soft)] transition hover:bg-[color:rgba(113,194,183,0.08)]"
                            >
                              {selectedTerminalName === terminal.name ? "Showing" : "Show facts"}
                            </button>
                            <div className="rounded-full border border-[color:rgba(113,194,183,0.18)] px-3 py-1 text-xs text-[color:var(--accent-soft)]">
                              from facts
                            </div>
                          </div>
                        </div>
                        {terminal.berths.length > 0 ? (
                          <div className="mt-4 flex flex-wrap gap-2">
                            {terminal.berths.map((berth) => (
                              <button
                                type="button"
                                key={berth.id}
                                onClick={() => toggleBerthFocus(terminal.name, berth.name)}
                                className="rounded-full border border-[color:rgba(113,194,183,0.2)] bg-[color:rgba(113,194,183,0.06)] px-3 py-1.5 text-xs uppercase tracking-[0.16em] text-[color:var(--accent-soft)]"
                              >
                                {berth.name}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}

                    {visibleStandaloneBerths.length > 0 ? (
                      <div className="rounded-[22px] border border-[color:var(--line-soft)] bg-[color:rgba(7,24,32,0.74)] p-4">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-[color:var(--ink-muted)]">Standalone Berths</div>
                        <div className="mt-4 flex flex-wrap gap-2">
                          {visibleStandaloneBerths.map((berth) => (
                            <div
                              key={berth.id}
                              className="flex items-center gap-2 rounded-full border border-[color:rgba(113,194,183,0.2)] bg-[color:rgba(113,194,183,0.06)] px-3 py-1.5 text-xs uppercase tracking-[0.16em] text-[color:var(--accent-soft)]"
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedTerminalName(null);
                                  setSelectedBerthName((current) =>
                                    current === berth.name ? null : berth.name
                                  );
                                }}
                                className="text-left"
                              >
                                {berth.name}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteBerth(berth.id, berth.name)}
                                className="rounded-full border border-[color:rgba(197,79,63,0.28)] px-2 py-0.5 text-[10px] tracking-[0.12em] text-[color:var(--danger)] transition hover:bg-[color:rgba(197,79,63,0.08)]"
                              >
                                x
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

            <section className="rounded-[28px] border border-[color:var(--line-strong)] bg-[color:rgba(8,24,33,0.82)] p-5">
              <div>
                <div className="text-[11px] uppercase tracking-[0.28em] text-[color:var(--ink-muted)]">Evidence dossier</div>
                <h3 className="mt-2 text-xl font-semibold text-[color:var(--ink-main)]">Operational categories</h3>
                {selectedTerminalName ? (
                  <div className="mt-2 text-sm text-[color:var(--ink-soft)]">
                    Focused on <span className="font-semibold text-[color:var(--accent-soft)]">{selectedTerminalName}</span>
                    {selectedBerthName ? (
                      <>
                        {" "}→ <span className="font-semibold text-[color:var(--accent-soft)]">{selectedBerthName}</span>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {!selectedPort && detailLoading ? (
                <p className="mt-6 text-sm text-[color:var(--ink-soft)]">Loading evidence dossier...</p>
              ) : !selectedPort ? (
                <p className="mt-6 text-sm text-[color:var(--ink-soft)]">Choose a port to review facts by category.</p>
              ) : orderedCategories.length === 0 ? (
                <p className="mt-6 text-sm text-[color:var(--ink-soft)]">No facts ingested yet for this port.</p>
              ) : (
                <div className="mt-5 space-y-6">
                  {orderedCategories.map((category) => (
                    <section key={category}>
                      {(() => {
                        const orderedCategoryFacts = [...groupedFacts[category]].sort((a, b) => {
                          const aCreated = new Date(a.createdAt).getTime();
                          const bCreated = new Date(b.createdAt).getTime();
                          if (aCreated !== bCreated) return bCreated - aCreated;

                          const aDate = a.sourceDate ? new Date(a.sourceDate).getTime() : 0;
                          const bDate = b.sourceDate ? new Date(b.sourceDate).getTime() : 0;
                          if (aDate !== bDate) return bDate - aDate;
                          return b.id - a.id;
                        });
                        const isExpanded = expandedCategoryKeys.includes(category);
                        const visibleCategoryFacts = isExpanded
                          ? orderedCategoryFacts
                          : orderedCategoryFacts.slice(0, 3);

                        return (
                          <>
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="text-[11px] uppercase tracking-[0.26em] text-[color:var(--ink-muted)]">
                          {CATEGORY_LABELS[category] ?? category}
                        </div>
                        <div className="text-xs text-[color:var(--ink-soft)]">
                          {orderedCategoryFacts.length} records
                        </div>
                      </div>
                      {hasNarrowFocus ? (
                        <EvidenceTable
                          facts={visibleCategoryFacts}
                          latestFactId={orderedCategoryFacts[0]?.id ?? null}
                          onDelete={handleDeleteFact}
                        />
                      ) : (
                        <div className="grid gap-3 xl:grid-cols-2">
                          {visibleCategoryFacts.map((fact) => (
                            <FactCard
                              key={fact.id}
                              fact={fact}
                              isLatest={fact.id === (orderedCategoryFacts[0]?.id ?? null)}
                              onDelete={handleDeleteFact}
                            />
                          ))}
                        </div>
                      )}
                      {orderedCategoryFacts.length > 3 ? (
                        <div className="mt-4 flex items-center justify-between gap-3">
                          <div className="text-xs text-[color:var(--ink-soft)]">
                            Showing {visibleCategoryFacts.length} of {orderedCategoryFacts.length} items
                          </div>
                          <button
                            type="button"
                            onClick={() => toggleCategoryExpansion(category)}
                            className="rounded-full border border-[color:var(--line-soft)] px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-[color:var(--accent-soft)] transition hover:border-[color:rgba(113,194,183,0.42)]"
                          >
                            {isExpanded ? "See Less" : "See All"}
                          </button>
                        </div>
                      ) : null}
                          </>
                        );
                      })()}
                    </section>
                  ))}
                </div>
              )}
            </section>

            </section>
          </main>

        </div>
      </div>

      {showIngest ? (
        <div
          className="fixed inset-0 z-[2000] flex items-center justify-center bg-[color:rgba(2,8,12,0.72)] p-4 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowIngest(false);
          }}
        >
          <div className="relative z-[2001] w-full max-w-3xl rounded-[32px] border border-[color:var(--line-strong)] bg-[linear-gradient(180deg,rgba(8,28,39,0.98),rgba(6,18,26,0.98))] p-6 shadow-[0_28px_80px_rgba(2,8,12,0.45)]">
            <div className="mb-4 flex items-center justify-end">
              <button
                onClick={() => setShowIngest(false)}
                className="rounded-full border border-[color:var(--line-soft)] px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-[color:var(--ink-soft)]"
              >
                Close
              </button>
            </div>
            <IngestForm
              onDone={({ portId, portName }) => {
                fetchPorts({ focusPortId: portId, focusPortName: portName, refreshDetail: true });
                setShowIngest(false);
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
