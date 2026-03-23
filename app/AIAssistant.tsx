"use client";

import { useMemo, useState } from "react";

type PortEntryForAssistant = {
  id: number;
  createdAt: string;
  port: string;
  country?: string | null;
  terminal: string;
  operation: string;
  dataSource?: string | null;
  sourceDate?: string | null;

  lat?: number | null;
  lon?: number | null;

  cargo?: string | null;
  waterDensity?: string | null;
  maxDraftMeters?: string | null;
  loaMeters?: string | null;
  beamMeters?: string | null;
  maxDwtMt?: string | null;

  transitPsNotes?: string | null;
  bunkeringPlace?: string | null;
  cleaningPermitted?: string | null;
  sulphurLimit?: string | null;

  specialRestrictions?: string | null;
  otherInfo?: string | null;
  restrictionsJson?: string | null;

  rawText?: string;
};

type Message = {
  role: "user" | "assistant";
  content: string;
};

function safeJsonPreview(entry: PortEntryForAssistant) {
  // короткий “контекст” — чтобы не отправлять мегабайты rawText
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    port: entry.port,
    country: entry.country ?? null,
    terminal: entry.terminal,
    operation: entry.operation,
    dataSource: entry.dataSource ?? null,
    sourceDate: entry.sourceDate ?? null,
    lat: entry.lat ?? null,
    lon: entry.lon ?? null,
    cargo: entry.cargo ?? null,
    maxDraftMeters: entry.maxDraftMeters ?? null,
    loaMeters: entry.loaMeters ?? null,
    beamMeters: entry.beamMeters ?? null,
    maxDwtMt: entry.maxDwtMt ?? null,
    waterDensity: entry.waterDensity ?? null,
    transitPsNotes: entry.transitPsNotes ?? null,
    bunkeringPlace: entry.bunkeringPlace ?? null,
    cleaningPermitted: entry.cleaningPermitted ?? null,
    sulphurLimit: entry.sulphurLimit ?? null,
    specialRestrictions: entry.specialRestrictions ?? null,
    otherInfo: entry.otherInfo ?? null,
    restrictionsJson: entry.restrictionsJson ?? null,
  };
}

export default function AIAssistant({
  entries,
  onHighlightPorts,
}: {
  entries: PortEntryForAssistant[];
  onHighlightPorts: (ports: string[]) => void;
}) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        "Ask me anything about your Port DB. Example: “Show ports with draft restrictions below 11m” or “Which ports require NAABSA?”",
    },
  ]);
  const [isAsking, setIsAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const portNames = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) if (e.port) set.add(e.port);
    return Array.from(set);
  }, [entries]);

  // Map terminal name -> port name so we can highlight the port when a terminal is mentioned
  const terminalToPort = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of entries) {
      if (e.terminal && e.port) map.set(e.terminal.toLowerCase(), e.port);
    }
    return map;
  }, [entries]);

  const detectMentionedPorts = (text: string) => {
    const lower = text.toLowerCase();
    const mentioned = new Set<string>();
    for (const p of portNames) {
      if (p && lower.includes(p.toLowerCase())) mentioned.add(p);
    }
    for (const [terminal, port] of terminalToPort) {
      if (terminal && lower.includes(terminal)) mentioned.add(port);
    }
    return Array.from(mentioned);
  };

  const ask = async () => {
    const q = input.trim();
    if (!q) return;

    setError(null);
    setIsAsking(true);

    const nextMessages: Message[] = [...messages, { role: "user", content: q }];
    setMessages(nextMessages);

    try {
      // Ограничим контекст, чтобы не упираться в лимиты.
      // Берём до 80 записей, но “сжатых” (без rawText).
      const context = entries.slice(0, 80).map(safeJsonPreview);

      // Send full conversation history (skip the initial welcome message at index 0)
      const history = nextMessages.slice(1).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data?.error || "Assistant error. Check server logs.");
        return;
      }

      const answer = String(data?.answer || "").trim();
      const assistantMsg: Message = {
        role: "assistant",
        content: answer || "(No answer returned.)",
      };

      setMessages((prev) => [...prev, assistantMsg]);
      setInput("");

      // Подсветка портов на карте по упоминанию в ответе
      const mentioned = detectMentionedPorts(answer);
      if (mentioned.length) onHighlightPorts(mentioned);
    } catch (e) {
      console.error(e);
      setError("Unexpected error while asking the assistant.");
    } finally {
      setIsAsking(false);
    }
  };

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-lg">AI Port Assistant</h2>

        <div className="flex flex-wrap gap-2">
          <button
            className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-xs"
            onClick={() => {
              setMessages([
                {
                  role: "assistant",
                  content:
                    "Ask me anything about your Port DB. Example: “Show ports with draft restrictions below 11m” or “Which ports require NAABSA?”",
                },
              ]);
              onHighlightPorts([]);
            }}
          >
            Clear chat
          </button>

          <button
            className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-xs"
            onClick={() => onHighlightPorts([])}
          >
            Clear map highlight
          </button>
        </div>
      </div>

      <div className="border border-slate-800 rounded-lg bg-slate-950 p-3 max-h-[320px] overflow-auto space-y-3 text-sm">
        {messages.map((m, idx) => (
          <div
            key={idx}
            className={
              m.role === "user"
                ? "text-slate-50"
                : "text-slate-200"
            }
          >
            <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">
              {m.role === "user" ? "You" : "Assistant"}
            </div>
            {m.role === "user" ? (
              <div className="whitespace-pre-wrap">{m.content}</div>
            ) : (
              <div className="space-y-1">
                {m.content.split("\n").map((line, i) => {
                  if (line.startsWith("⚠️")) {
                    return (
                      <div key={i} className="bg-yellow-950/40 border border-yellow-600/50 rounded px-3 py-2">
                        {line}
                      </div>
                    );
                  }
                  if (line.startsWith("•")) {
                    return <div key={i} className="pl-4">{line}</div>;
                  }
                  if (line.startsWith("→")) {
                    return <div key={i} className="text-emerald-400">{line}</div>;
                  }
                  return <div key={i}>{line}</div>;
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      {error && (
        <div className="text-sm text-red-400 border border-red-700/60 bg-red-950/40 px-3 py-2 rounded-md">
          {error}
        </div>
      )}

      <div className="flex flex-col md:flex-row gap-3">
        <input
          className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
          placeholder='Ask: "Show ports with max draft < 11m"'
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!isAsking) ask();
            }
          }}
        />

        <button
          onClick={ask}
          disabled={isAsking}
          className="inline-flex items-center justify-center px-4 py-2 rounded-md bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 text-sm font-medium"
        >
          {isAsking ? "Thinking…" : "Ask"}
        </button>
      </div>

      <div className="text-xs text-slate-400">
        Tip: ask “Highlight ports with tide / NAABSA / trim / air draft issues”.
        If the assistant mentions port names, they will be highlighted on the map.
      </div>
    </section>
  );
}