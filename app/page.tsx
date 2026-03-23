"use client";

import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import dynamic from "next/dynamic";
import AIAssistant from "./AIAssistant";

// ВАЖНО: карта должна грузиться без SSR
const PortsMap = dynamic(() => import("./PortsMap"), { ssr: false });

type PortEntry = {
  id: number;
  createdAt: string; // ISO string from API
  port: string;
  country?: string | null;
  terminal: string;
  operation: string;
  dataSource?: string | null;
  sourceDate?: string | null;

  lat?: number | null;
  lon?: number | null;

  cargo?: string | null;
  stowFactor?: string | null;
  quantityInfo?: string | null;
  typeOfCargoesHandled?: string | null;
  productionPerDay?: string | null;
  numberOfGangs?: string | null;
  shiftsInfo?: string | null;
  equipmentUsed?: string | null;
  shiftsPerDay?: string | null;

  waterDensity?: string | null;
  maxDraftMeters?: string | null;
  maxDraftNotes?: string | null;
  loaMeters?: string | null;
  beamMeters?: string | null;
  maxDwtMt?: string | null;
  airDraftMeters?: string | null;
  spoutAirDraft?: string | null;
  waterlineToHatchCoaming?: string | null;
  minFreeboardMeters?: string | null;
  requiredTrim?: string | null;

  loadRatePerDayMt?: string | null;
  dischargeRatePerDayMt?: string | null;

  agents?: string | null;
  costDockage?: string | null;
  costPilotage?: string | null;
  costTowage?: string | null;
  costTotalEstimate?: string | null;

  transitPsNotes?: string | null;
  bunkeringPlace?: string | null;
  cleaningPermitted?: string | null;
  sulphurLimit?: string | null;

  bunkeringNotes?: string | null;
  cleaningNotes?: string | null;

  specialRestrictions?: string | null;
  otherInfo?: string | null;
  restrictionsJson?: string | null;

  rawText: string;
};

export default function HomePage() {
  const [text, setText] = useState("");
  const [dataSource, setDataSource] = useState("");
  const [sourceDate, setSourceDate] = useState("");
  const [entries, setEntries] = useState<PortEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // PDF пока “на паузе”, но оставим состояние — можешь потом вернуть.
  const [isPdfUploading, setIsPdfUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [filterOperation, setFilterOperation] = useState<string>("ALL");
  const [filterPort, setFilterPort] = useState<string>("ALL");

  const [highlightedPorts, setHighlightedPorts] = useState<string[]>([]);

  // Load existing entries on mount
  useEffect(() => {
    const loadEntries = async () => {
      try {
        const res = await fetch("/api/ports");
        if (!res.ok) {
          console.error("Failed to load ports:", await res.text());
          return;
        }
        const data = await res.json();
        if (Array.isArray(data.entries)) {
          setEntries(data.entries);
        }
      } catch (e) {
        console.error("Error loading ports:", e);
      }
    };

    loadEntries();
  }, []);

  // (PDF пока отключён — оставляю функцию, чтобы не ломать структуру)
  const handlePdfUpload = async (_event: ChangeEvent<HTMLInputElement>) => {
    setError(
      "PDF ingestion is paused for now. Paste text from PDF into the textbox instead."
    );
    setIsPdfUploading(false);
  };

  const handleIngest = async () => {
    setError(null);

    const trimmed = text.trim();
    if (!trimmed) {
      setError("Please paste some port / terminal information first.");
      return;
    }

    try {
      setIsLoading(true);
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: trimmed,
          dataSource: dataSource.trim() || null,
          sourceDate: sourceDate || null,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        console.error("INGEST ERROR:", data);
        setError(
          data?.error ||
            "Error while processing this block. Please check the text and try again."
        );
      } else {
        if (data.entry) {
          setEntries((prev) => [data.entry as PortEntry, ...prev]);
          setText("");
          setDataSource("");
          setSourceDate("");
        }
      }
    } catch (e: any) {
      console.error("INGEST FATAL ERROR:", e);
      setError("Internal server error while ingesting. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  // ✅ Delete one PortEntry by id
  const handleDeleteEntry = async (id: number) => {
    setError(null);

    const ok = confirm(`Delete entry #${id}? This cannot be undone.`);
    if (!ok) return;

    try {
      const res = await fetch(`/api/port-entries/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        console.error("DELETE ERROR:", data);
        setError(data?.error || "Failed to delete entry.");
        return;
      }

      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (e) {
      console.error("DELETE FATAL ERROR:", e);
      setError("Unexpected error while deleting.");
    }
  };

  const uniquePorts = useMemo(() => {
    const set = new Set<string>();
    entries.forEach((e) => {
      if (e.port) set.add(e.port);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [entries]);

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    return entries.filter((e) => {
      if (filterOperation !== "ALL" && e.operation !== filterOperation) {
        return false;
      }
      if (filterPort !== "ALL" && e.port !== filterPort) {
        return false;
      }

      if (!q) return true;

      const haystack =
        [
          e.port,
          e.country,
          e.terminal,
          e.operation,
          e.cargo,
          e.typeOfCargoesHandled,
          e.productionPerDay,
          e.numberOfGangs,
          e.shiftsInfo,
          e.equipmentUsed,
          e.shiftsPerDay,
          e.waterDensity,
          e.maxDraftMeters,
          e.maxDraftNotes,
          e.loaMeters,
          e.beamMeters,
          e.maxDwtMt,
          e.airDraftMeters,
          e.spoutAirDraft,
          e.waterlineToHatchCoaming,
          e.requiredTrim,
          e.loadRatePerDayMt,
          e.dischargeRatePerDayMt,
          e.agents,
          e.costDockage,
          e.costPilotage,
          e.costTowage,
          e.costTotalEstimate,
          e.transitPsNotes,
          e.bunkeringPlace,
          e.cleaningPermitted,
          e.sulphurLimit,
          e.specialRestrictions,
          e.otherInfo,
          e.rawText,
          String(e.lat ?? ""),
          String(e.lon ?? ""),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase() || "";

      return haystack.includes(q);
    });
  }, [entries, searchQuery, filterOperation, filterPort]);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50">
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
        {/* Header */}
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Port Intelligence DB</h1>
          <p className="text-sm text-slate-300">
            Paste port / terminal info from agents. The system extracts structured data and stores it.
            Use the AI Assistant + Global Map to search restrictions globally.
          </p>
        </header>

        {/* Ingest form */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-4">
          <h2 className="font-semibold text-lg">1. Ingest new port info</h2>

          {/* PDF upload (paused) */}
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <label className="text-sm font-medium">Upload PDF (paused):</label>
            <input
              type="file"
              accept="application/pdf"
              onChange={handlePdfUpload}
              className="text-xs file:text-xs file:px-2 file:py-1 file:rounded-md file:border-0 file:bg-slate-700 file:text-slate-50 hover:file:bg-slate-600 cursor-pointer"
            />
            {isPdfUploading && (
              <span className="text-xs text-slate-400">Reading PDF…</span>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="block text-xs uppercase tracking-wide text-slate-400">
                Source / Agent name
              </label>
              <input
                type="text"
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                placeholder="e.g. GAC, Sinoagent, COSCO Shipping..."
                value={dataSource}
                onChange={(e) => setDataSource(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs uppercase tracking-wide text-slate-400">
                Info date (when agent sent this)
              </label>
              <input
                type="date"
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                value={sourceDate}
                onChange={(e) => setSourceDate(e.target.value)}
              />
            </div>
          </div>

          <label className="block text-sm font-medium mb-1">
            Raw message from agents (email text / copy-paste from PDF / etc.)
          </label>
          <textarea
            className="w-full h-48 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            placeholder="Paste the full port / terminal description..."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />

          {error && (
            <div className="text-sm text-red-400 border border-red-700/60 bg-red-950/40 px-3 py-2 rounded-md">
              {error}
            </div>
          )}

          <button
            onClick={handleIngest}
            disabled={isLoading}
            className="inline-flex items-center px-4 py-2 rounded-md bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 text-sm font-medium"
          >
            {isLoading ? "Processing & saving…" : "Ingest & Save"}
          </button>
        </section>

        {/* AI Assistant */}
        <AIAssistant
          entries={filteredEntries}
          onHighlightPorts={(ports) => setHighlightedPorts(ports)}
        />

        {/* Global Map */}
        <PortsMap entries={filteredEntries} highlightedPorts={highlightedPorts} />

        {/* Filters */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-4">
          <h2 className="font-semibold text-lg">2. Search & filter ports</h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="block text-xs uppercase tracking-wide text-slate-400">
                Free text search
              </label>
              <input
                type="text"
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                placeholder="Port, cargo, draft, agents, restriction text..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <label className="block text-xs uppercase tracking-wide text-slate-400">
                Operation type
              </label>
              <select
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                value={filterOperation}
                onChange={(e) => setFilterOperation(e.target.value)}
              >
                <option value="ALL">All operations</option>
                <option value="Load">Load</option>
                <option value="Discharge">Discharge</option>
                <option value="Bunker">Bunker</option>
                <option value="Load/Discharge">Load/Discharge</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="block text-xs uppercase tracking-wide text-slate-400">
                Port
              </label>
              <select
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                value={filterPort}
                onChange={(e) => setFilterPort(e.target.value)}
              >
                <option value="ALL">All ports</option>
                {uniquePorts.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* Table */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-lg">3. Stored entries</h2>
            <span className="text-xs text-slate-400">
              Showing {filteredEntries.length} of {entries.length} records
            </span>
          </div>

          <div className="overflow-x-auto border border-slate-800 rounded-lg">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-900/80 border-b border-slate-800">
                <tr className="text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="px-2 py-2 text-left">Actions</th>
                  <th className="px-2 py-2 text-left">Created</th>
                  <th className="px-2 py-2 text-left">Source</th>
                  <th className="px-2 py-2 text-left">Terminal</th>
                  <th className="px-2 py-2 text-left">Operation</th>
                  <th className="px-2 py-2 text-left">Lat</th>
                  <th className="px-2 py-2 text-left">Lon</th>
                  <th className="px-2 py-2 text-left">Cargo</th>
                  <th className="px-2 py-2 text-left">Prod/day</th>
                  <th className="px-2 py-2 text-left">Gangs / shifts</th>
                  <th className="px-2 py-2 text-left">Water density</th>
                  <th className="px-2 py-2 text-left">Draft</th>
                  <th className="px-2 py-2 text-left">LOA</th>
                  <th className="px-2 py-2 text-left">Beam</th>
                  <th className="px-2 py-2 text-left">Max DWT</th>
                  <th className="px-2 py-2 text-left">Transit / bunkering</th>
                  <th className="px-2 py-2 text-left">Restrictions & other</th>
                  <th className="px-2 py-2 text-left">Raw text</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  if (filteredEntries.length === 0) {
                    return (
                      <tr>
                        <td className="px-2 py-4 text-center text-slate-400" colSpan={18}>
                          No records match current filters.
                        </td>
                      </tr>
                    );
                  }

                  // Group by port (case-insensitive), preserve first-seen order
                  const groups: { portKey: string; portName: string; country?: string | null; entries: PortEntry[] }[] = [];
                  const seenKeys = new Map<string, number>();
                  for (const e of filteredEntries) {
                    const key = e.port.toLowerCase();
                    if (seenKeys.has(key)) {
                      groups[seenKeys.get(key)!].entries.push(e);
                    } else {
                      seenKeys.set(key, groups.length);
                      groups.push({ portKey: key, portName: e.port, country: e.country, entries: [e] });
                    }
                  }

                  return groups.flatMap((group) => [
                    <tr key={`group-${group.portKey}`}>
                      <td colSpan={18} className="bg-slate-800 text-slate-200 font-bold px-2 py-2">
                        {group.portName}
                        {group.country ? ` — ${group.country}` : ""}
                        {" "}({group.entries.length} terminal{group.entries.length !== 1 ? "s" : ""})
                      </td>
                    </tr>,
                    ...group.entries.map((e) => (
                      <tr
                        key={e.id}
                        className="border-t border-slate-800/80 hover:bg-slate-800/40"
                      >
                        <td className="px-2 py-2 align-top">
                          <button
                            onClick={() => handleDeleteEntry(e.id)}
                            className="text-red-400 hover:text-red-300 underline text-xs"
                            title={`Delete entry #${e.id}`}
                          >
                            Delete
                          </button>
                        </td>

                        <td className="px-2 py-2 align-top">
                          {e.createdAt ? new Date(e.createdAt).toLocaleString() : ""}
                        </td>

                        <td className="px-2 py-2 align-top">
                          {e.dataSource && <div className="font-medium">{e.dataSource}</div>}
                          {e.sourceDate && (
                            <div className="text-slate-400 text-[11px]">
                              {new Date(e.sourceDate).toLocaleDateString("en-GB")}
                            </div>
                          )}
                        </td>

                        <td className="px-2 py-2 align-top">
                          {e.terminal}
                          {e.agents && (
                            <div className="text-slate-400 mt-1">Agents: {e.agents}</div>
                          )}
                        </td>

                        <td className="px-2 py-2 align-top">{e.operation}</td>

                        <td className="px-2 py-2 align-top">
                          {typeof e.lat === "number" ? e.lat.toFixed(5) : ""}
                        </td>
                        <td className="px-2 py-2 align-top">
                          {typeof e.lon === "number" ? e.lon.toFixed(5) : ""}
                        </td>

                        <td className="px-2 py-2 align-top">
                          {e.cargo && <div>{e.cargo}</div>}
                          {e.typeOfCargoesHandled && (
                            <div className="text-slate-400">Types: {e.typeOfCargoesHandled}</div>
                          )}
                          {e.stowFactor && <div className="text-slate-400">SF: {e.stowFactor}</div>}
                          {e.quantityInfo && <div className="text-slate-400">{e.quantityInfo}</div>}
                        </td>

                        <td className="px-2 py-2 align-top">
                          {e.productionPerDay && <div>{e.productionPerDay}</div>}
                          {e.loadRatePerDayMt && (
                            <div className="text-slate-400">Load: {e.loadRatePerDayMt}</div>
                          )}
                          {e.dischargeRatePerDayMt && (
                            <div className="text-slate-400">Disch: {e.dischargeRatePerDayMt}</div>
                          )}
                        </td>

                        <td className="px-2 py-2 align-top">
                          {e.numberOfGangs && <div>Gangs: {e.numberOfGangs}</div>}
                          {e.shiftsInfo && <div className="text-slate-400">Shifts: {e.shiftsInfo}</div>}
                          {e.shiftsPerDay && (
                            <div className="text-slate-400">Shifts/day: {e.shiftsPerDay}</div>
                          )}
                          {e.equipmentUsed && (
                            <div className="text-slate-400">Equipment: {e.equipmentUsed}</div>
                          )}
                        </td>

                        <td className="px-2 py-2 align-top">{e.waterDensity}</td>

                        <td className="px-2 py-2 align-top">
                          {e.maxDraftMeters && <div>{e.maxDraftMeters}</div>}
                          {e.maxDraftNotes && <div className="text-slate-400">{e.maxDraftNotes}</div>}
                          {e.requiredTrim && <div className="text-slate-400">Trim: {e.requiredTrim}</div>}
                        </td>

                        <td className="px-2 py-2 align-top">{e.loaMeters}</td>
                        <td className="px-2 py-2 align-top">{e.beamMeters}</td>
                        <td className="px-2 py-2 align-top">{e.maxDwtMt}</td>

                        <td className="px-2 py-2 align-top">
                          {e.transitPsNotes && <div>Transit: {e.transitPsNotes}</div>}
                          {e.bunkeringPlace && (
                            <div className="text-slate-400">Bunkers: {e.bunkeringPlace}</div>
                          )}
                          {e.cleaningPermitted && (
                            <div className="text-slate-400">Cleaning: {e.cleaningPermitted}</div>
                          )}
                          {e.sulphurLimit && (
                            <div className="text-slate-400">Sulphur: {e.sulphurLimit}</div>
                          )}
                        </td>

                        <td className="px-2 py-2 align-top max-w-xs">
                          {e.specialRestrictions && (
                            <div className="mb-1">
                              <span className="font-semibold">Special restrictions:</span>{" "}
                              {e.specialRestrictions}
                            </div>
                          )}
                          {e.otherInfo && (
                            <div className="text-slate-300">
                              <span className="font-semibold">Other:</span> {e.otherInfo}
                            </div>
                          )}
                          {e.restrictionsJson && (
                            <details className="mt-2">
                              <summary className="cursor-pointer text-emerald-400">
                                Show auto-categories
                              </summary>
                              <pre className="mt-1 whitespace-pre-wrap text-[10px] text-slate-300">
                                {e.restrictionsJson}
                              </pre>
                            </details>
                          )}
                        </td>

                        <td className="px-2 py-2 align-top max-w-xs">
                          <details>
                            <summary className="cursor-pointer text-emerald-400">
                              Show raw text
                            </summary>
                            <pre className="mt-1 whitespace-pre-wrap text-[10px] text-slate-300">
                              {e.rawText}
                            </pre>
                          </details>
                        </td>
                      </tr>
                    )),
                  ]);
                })()}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}