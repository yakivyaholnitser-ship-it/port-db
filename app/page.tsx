"use client";

import { useEffect, useState } from "react";
import type { PortEntry } from "@prisma/client";

type PortEntryWithCreatedAtString = Omit<PortEntry, "createdAt"> & {
  createdAt: string;
};

export default function HomePage() {
  const [text, setText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [entries, setEntries] = useState<PortEntryWithCreatedAtString[]>([]);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [messageType, setMessageType] = useState<"success" | "error">(
    "success"
  );

  // подтягиваем записи из /api/ports
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/ports");
        if (!res.ok) {
          throw new Error("Failed to load ports");
        }
        const data = await res.json();
        setEntries(data.entries ?? []);
      } catch (err) {
        console.error("LOAD /api/ports ERROR:", err);
      }
    };

    load();
  }, []);

  function showToast(msg: string, type: "success" | "error" = "success") {
    setMessage(msg);
    setMessageType(type);
    setTimeout(() => setMessage(null), 3500);
  }

  async function handleIngest() {
    if (!text.trim()) {
      showToast("Вставь текст по порту/терминалу.", "error");
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      const data = await res.json();

      if (!res.ok) {
        console.error("INGEST ERROR:", data);
        showToast(
          data?.error ||
            "Ошибка при обработке. Проверь текст и попробуй ещё раз.",
          "error"
        );
      } else {
        if (data.entry) {
          setEntries((prev) => [data.entry, ...prev]);
        }
        setText("");
        showToast("Запись успешно сохранена.", "success");
      }
    } catch (err) {
      console.error("INGEST FATAL ERROR:", err);
      showToast(
        "Внутренняя ошибка сервера при обработке. Подробности смотри в логах сервера.",
        "error"
      );
    } finally {
      setIsLoading(false);
    }
  }

  // фильтр по поиску
  const filtered = entries.filter((e) => {
    const q = search.toLowerCase();
    if (!q) return true;
    return (
      e.port.toLowerCase().includes(q) ||
      (e.terminal ?? "").toLowerCase().includes(q) ||
      (e.operation ?? "").toLowerCase().includes(q) ||
      (e.cargo ?? "").toLowerCase().includes(q) ||
      (e.stowFactor ?? "").toLowerCase().includes(q) ||
      (e.notes ?? "").toLowerCase().includes(q) ||
      (e.rawText ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-2xl md:text-3xl font-bold mb-4">
          Port DB — Ingest
        </h1>

        {/* textarea + кнопка */}
        <div className="mb-4 space-y-2">
          <textarea
            className="w-full h-40 border border-slate-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500 bg-white"
            placeholder="- Port / Terminal block сюда..."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <button
              onClick={handleIngest}
              disabled={isLoading}
              className="inline-flex items-center px-4 py-2 rounded-md bg-sky-600 text-white text-sm font-medium hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? "Обработка..." : "Ingest & Save"}
            </button>
            {message && (
              <span
                className={`text-xs ${
                  messageType === "success" ? "text-emerald-700" : "text-red-600"
                }`}
              >
                {message}
              </span>
            )}
          </div>
        </div>

        {/* поиск */}
        <div className="mb-4">
          <input
            type="text"
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500 bg-white"
            placeholder="Поиск: порт, терминал, cargo, текст..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <p className="mt-1 text-[11px] text-slate-400">
            Например: Long Beach, LB212, cement, discharge...
          </p>
        </div>

        {/* таблица */}
        <section className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-x-auto">
          <table className="min-w-full text-xs md:text-sm border-collapse">
            <thead className="bg-slate-100 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 border-b border-slate-200 text-left whitespace-nowrap">
                  Date ↓
                </th>
                <th className="px-3 py-2 border-b border-slate-200 text-left">
                  Port
                </th>
                <th className="px-3 py-2 border-b border-slate-200 text-left">
                  Terminal
                </th>
                <th className="px-3 py-2 border-b border-slate-200 text-left">
                  Operation
                </th>
                <th className="px-3 py-2 border-b border-slate-200 text-left whitespace-nowrap">
                  Cargo /
                  <br />
                  SF
                </th>
                <th className="px-3 py-2 border-b border-slate-200 text-left whitespace-nowrap">
                  Water
                  <br />
                  density
                </th>
                {/* новые колонки */}
                <th className="px-3 py-2 border-b border-slate-200 text-left whitespace-nowrap">
                  LOA
                  <br />
                  (m)
                </th>
                <th className="px-3 py-2 border-b border-slate-200 text-left whitespace-nowrap">
                  Beam
                  <br />
                  (m)
                </th>
                <th className="px-3 py-2 border-b border-slate-200 text-left whitespace-nowrap">
                  DWT
                  <br />
                  (mt)
                </th>
                {/* конец новых колонок */}
                <th className="px-3 py-2 border-b border-slate-200 text-left whitespace-nowrap">
                  Max
                  <br />
                  draft (m)
                </th>
                <th className="px-3 py-2 border-b border-slate-200 text-left whitespace-nowrap">
                  Load /
                  <br />
                  Disch rate
                  <br />
                  (MT/day)
                </th>
                <th className="px-3 py-2 border-b border-slate-200 text-left">
                  Notes
                </th>
                <th className="px-3 py-2 border-b border-slate-200 text-left">
                  Raw text
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => {
                // нормальное отображение даты
                let dateLabel = "Invalid Date";
                try {
                  const d = new Date(e.createdAt);
                  if (!isNaN(d.getTime())) {
                    dateLabel = d.toLocaleDateString("en-GB");
                  }
                } catch {
                  // оставляем Invalid Date
                }

                const cargoSf = [e.cargo, e.stowFactor].filter(Boolean).join(" / ");

                // max draft
                const maxDraft = e.maxDraftMeters || "";

                // rate
                const rate =
                  e.loadRatePerDayMt ||
                  e.dischargeRatePerDayMt ||
                  "";

                return (
                  <tr key={e.id} className="align-top hover:bg-slate-50">
                    <td className="px-3 py-2 border-b border-slate-100 text-[11px] text-slate-500 whitespace-nowrap">
                      {dateLabel}
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100 font-medium whitespace-nowrap">
                      {e.port}
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100 whitespace-nowrap">
                      {e.terminal}
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100 whitespace-nowrap">
                      {e.operation}
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100">
                      <div className="flex flex-col gap-0.5">
                        {e.cargo && (
                          <span>
                            <span className="text-slate-500">Cargo: </span>
                            {e.cargo}
                          </span>
                        )}
                        {e.stowFactor && (
                          <span className="text-[11px] text-slate-500">
                            SF: {e.stowFactor}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100 whitespace-nowrap">
                      {e.waterDensity || "—"}
                    </td>

                    {/* LOA */}
                    <td className="px-3 py-2 border-b border-slate-100 whitespace-nowrap">
                      {e.loaMeters || "—"}
                    </td>

                    {/* Beam */}
                    <td className="px-3 py-2 border-b border-slate-100 whitespace-nowrap">
                      {e.beamMeters || "—"}
                    </td>

                    {/* DWT */}
                    <td className="px-3 py-2 border-b border-slate-100 whitespace-nowrap">
                      {e.maxDwtMt || "—"}
                    </td>

                    {/* Max draft */}
                    <td className="px-3 py-2 border-b border-slate-100 whitespace-nowrap">
                      {maxDraft ? (
                        <span>
                          {maxDraft}
                          {e.maxDraftNotes ? (
                            <span className="text-[11px] text-slate-500">
                              {" "}
                              ({e.maxDraftNotes})
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>

                    {/* rate */}
                    <td className="px-3 py-2 border-b border-slate-100 whitespace-nowrap">
                      {rate ? (
                        <span>
                          {rate}
                          {e.operation === "Load" ? (
                            <span className="text-[11px] text-slate-500">
                              {" "}
                              (load)
                            </span>
                          ) : e.operation === "Discharge" ? (
                            <span className="text-[11px] text-slate-500">
                              {" "}
                              (disch)
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>

                    {/* notes */}
                    <td className="px-3 py-2 border-b border-slate-100 text-[11px] text-slate-600 max-w-xs">
                      {e.specialRestrictions || e.notes || "—"}
                    </td>

                    {/* raw text toggle */}
                    <td className="px-3 py-2 border-b border-slate-100 text-[11px] text-sky-600 underline cursor-pointer">
                      <details>
                        <summary>› Raw text</summary>
                        <pre className="mt-1 whitespace-pre-wrap text-[10px] text-slate-600 bg-slate-50 border border-slate-100 rounded p-2 max-h-64 overflow-auto">
                          {e.rawText}
                        </pre>
                      </details>
                    </td>
                  </tr>
                );
              })}

              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={13}
                    className="px-3 py-6 text-center text-sm text-slate-400"
                  >
                    Записей нет. Вставь блок по порту/терминалу и нажми{" "}
                    <strong>Ingest &amp; Save</strong>.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  );
}