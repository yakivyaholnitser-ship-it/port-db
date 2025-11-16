"use client";

import { useEffect, useState } from "react";

type PortEntryWithCreatedAtString = {
  id: number;
  createdAtString: string;

  port: string;
  country: string | null;
  terminal: string;
  operation: string;

  cargo: string | null;
  stowFactor: string | null;
  quantityInfo: string | null;

  waterDensity: string | null;
  maxDraftMeters: string | null;
  maxDraftNotes: string | null;
  loaMeters: string | null;
  beamMeters: string | null;
  maxDwtMt: string | null;
  airDraftMeters: string | null;
  minFreeboardMeters: string | null;

  loadRatePerDayMt: string | null;
  dischargeRatePerDayMt: string | null;

  agents: string | null;
  costDockage: string | null;
  costPilotage: string | null;
  costTowage: string | null;
  costTotalEstimate: string | null;

  bunkeringNotes: string | null;
  cleaningNotes: string | null;
  transitPsNotes: string | null;
  sulphurLimit: string | null;
  specialRestrictions: string | null;

  rawText: string;
};

type IngestResponse =
  | { success: true; entry: PortEntryWithCreatedAtString }
  | { success: false; error: string };

export default function HomePage() {
  const [text, setText] = useState("");
  const [entries, setEntries] = useState<PortEntryWithCreatedAtString[]>([]);
  const [search, setSearch] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [statusType, setStatusType] = useState<"ok" | "error" | null>(null);
  const [expandedIds, setExpandedIds] = useState<number[]>([]);

  // загрузка записей
  useEffect(() => {
    const fetchEntries = async () => {
      try {
        const res = await fetch("/api/ports");
        if (!res.ok) {
          console.error("Failed to fetch ports", await res.text());
          return;
        }
        const data = (await res.json()) as {
          entries: PortEntryWithCreatedAtString[];
        };
        setEntries(data.entries ?? []);
      } catch (e) {
        console.error("Error loading ports:", e);
      }
    };
    fetchEntries();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);
    setStatusType(null);

    const trimmed = text.trim();
    if (!trimmed) {
      setStatus("Поле ввода пустое. Вставь текст по порту/терминалу.");
      setStatusType("error");
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });

      if (!res.ok) {
        let message = "Внутренняя ошибка сервера при обработке.";
        try {
          const data = (await res.json()) as IngestResponse | any;
          if (data && typeof data.error === "string") {
            message = data.error;
          }
          console.error("INGEST ERROR:", data);
        } catch {
          console.error("INGEST ERROR RAW:", await res.text());
        }
        setStatus(message + " Подробности смотри в логах сервера.");
        setStatusType("error");
        return;
      }

      const data = (await res.json()) as IngestResponse;

      if (!data.success) {
        setStatus(
          data.error ||
            "Ошибка при обработке. Проверь текст и попробуй ещё раз."
        );
        setStatusType("error");
      } else {
        if (data.entry) {
          setEntries((prev) => [data.entry, ...prev]);
        }
        setText("");
        setStatus("Запись успешно сохранена.");
        setStatusType("ok");
      }
    } catch (err) {
      console.error("INGEST FATAL ERROR:", err);
      setStatus("Неожиданная ошибка сервера при обработке.");
      setStatusType("error");
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleRaw = (id: number) => {
    setExpandedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const filteredEntries = entries.filter((e) => {
    const q = search.toLowerCase();
    return (
      e.port.toLowerCase().includes(q) ||
      (e.terminal ?? "").toLowerCase().includes(q) ||
      (e.operation ?? "").toLowerCase().includes(q) ||
      (e.cargo ?? "").toLowerCase().includes(q) ||
      (e.stowFactor ?? "").toLowerCase().includes(q) ||
      (e.specialRestrictions ?? "").toLowerCase().includes(q) ||
      (e.rawText ?? "").toLowerCase().includes(q)
    );
  });

  const formatDate = (createdAtString: string) => {
    const d = new Date(createdAtString);
    if (Number.isNaN(d.getTime())) return "Invalid Date";
    return d.toLocaleDateString("uk-UA", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
    });
  };

  const renderCell = (value: string | null | undefined) =>
    value && value.trim().length > 0 ? value : "—";

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <h1 className="mb-4 text-2xl font-semibold">Port DB — Ingest</h1>

        {/* форма инжеста */}
        <form onSubmit={handleSubmit} className="mb-4 space-y-2">
          <textarea
            className="h-40 w-full rounded-md border border-slate-300 bg-white p-2 text-sm outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
            placeholder="- Port / Terminal block сюда..."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center gap-4">
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-sky-400"
            >
              {isSubmitting ? "Сохраняю..." : "Ingest & Save"}
            </button>
            {status && (
              <span
                className={
                  statusType === "ok"
                    ? "text-sm text-emerald-600"
                    : "text-sm text-rose-600"
                }
              >
                {status}
              </span>
            )}
          </div>
        </form>

        {/* поиcк */}
        <div className="mb-4">
          <input
            className="w-full rounded-md border border-slate-300 bg-white p-2 text-sm outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
            placeholder="Поиск: порт, терминал, cargo, текст…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate-500">
            Например: Long Beach, LB212, cement, discharge…
          </p>
        </div>

        {/* таблица */}
        <section>
          <h2 className="mb-2 text-lg font-semibold">Записи</h2>

          <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
            <table className="min-w-full border-collapse text-xs">
              <thead className="bg-slate-100 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="border-b border-slate-200 px-2 py-2 text-left">
                    Date ↓
                  </th>
                  <th className="border-b border-slate-200 px-2 py-2 text-left">
                    Port
                  </th>
                  <th className="border-b border-slate-200 px-2 py-2 text-left">
                    Terminal
                  </th>
                  <th className="border-b border-slate-200 px-2 py-2 text-left">
                    Operation
                  </th>
                  <th className="border-b border-slate-200 px-2 py-2 text-left">
                    CARGO / SF
                  </th>
                  <th className="border-b border-slate-200 px-2 py-2 text-left">
                    WATER DENSITY
                  </th>
                  <th className="border-b border-slate-200 px-2 py-2 text-left">
                    Max draft (m)
                  </th>
                  <th className="border-b border-slate-200 px-2 py-2 text-left">
                    Load / Disch rate (MT/day)
                  </th>
                  <th className="border-b border-slate-200 px-2 py-2 text-left">
                    NOTES / Restrictions
                  </th>
                  <th className="border-b border-slate-200 px-2 py-2 text-left">
                    Raw
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredEntries.length === 0 ? (
                  <tr>
                    <td
                      colSpan={10}
                      className="px-2 py-4 text-center text-xs text-slate-400"
                    >
                      Нет записей. Вставь один из блоков по порту и нажми
                      &laquo;Ingest &amp; Save&raquo;.
                    </td>
                  </tr>
                ) : (
                  filteredEntries.map((e) => (
                    <tr
                      key={e.id}
                      className="border-t border-slate-100 align-top hover:bg-slate-50"
                    >
                      <td className="px-2 py-2 text-[11px] text-slate-500">
                        {formatDate(e.createdAtString)}
                      </td>
                      <td className="px-2 py-2 text-xs font-medium text-slate-900">
                        {renderCell(e.port)}
                      </td>
                      <td className="px-2 py-2 text-xs text-slate-900">
                        {renderCell(e.terminal)}
                      </td>
                      <td className="px-2 py-2 text-xs text-slate-900">
                        {renderCell(e.operation)}
                      </td>
                      <td className="px-2 py-2 text-xs text-slate-900">
                        {e.cargo ? (
                          <>
                            {e.cargo}
                            {e.stowFactor ? (
                              <>
                                , <span className="text-slate-500">
                                  {e.stowFactor}
                                </span>
                              </>
                            ) : null}
                          </>
                        ) : e.stowFactor ? (
                          e.stowFactor
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-2 py-2 text-xs text-slate-900">
                        {renderCell(e.waterDensity)}
                      </td>
                      <td className="px-2 py-2 text-xs text-slate-900">
                        {e.maxDraftMeters
                          ? `${e.maxDraftMeters} m${
                              e.maxDraftNotes ? "" : ""
                            }`
                          : "—"}
                        {e.maxDraftNotes ? (
                          <>
                            <br />
                            <span className="text-[11px] text-slate-500">
                              ({e.maxDraftNotes})
                            </span>
                          </>
                        ) : null}
                      </td>
                      <td className="px-2 py-2 text-xs text-slate-900">
                        {e.loadRatePerDayMt ? (
                          <>
                            {e.loadRatePerDayMt}{" "}
                            <span className="text-[11px] text-slate-500">
                              (load)
                            </span>
                          </>
                        ) : e.dischargeRatePerDayMt ? (
                          <>
                            {e.dischargeRatePerDayMt}{" "}
                            <span className="text-[11px] text-slate-500">
                              (disch)
                            </span>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-2 py-2 text-xs text-slate-900">
                        {e.specialRestrictions ? (
                          <div>{e.specialRestrictions}</div>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-xs">
                        <button
                          type="button"
                          onClick={() => toggleRaw(e.id)}
                          className="text-[11px] text-sky-600 underline-offset-2 hover:underline"
                        >
                          {expandedIds.includes(e.id)
                            ? "Скрыть raw text"
                            : "› Raw text"}
                        </button>
                        {expandedIds.includes(e.id) && (
                          <pre className="mt-1 max-h-40 overflow-auto rounded border border-slate-200 bg-slate-50 p-1 text-[10px] leading-snug text-slate-700">
                            {e.rawText}
                          </pre>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}