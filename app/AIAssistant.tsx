"use client";

import { useEffect, useMemo, useState } from "react";

type PortOption = {
  id: number;
  name: string;
  country?: string | null;
};

type TerminalOption = {
  id: number;
  name: string;
  berths: { id: number; name: string }[];
};

type StandaloneBerthOption = {
  id: number;
  name: string;
};

type AssistantPortDetail = {
  id: number;
  name: string;
  country: string | null;
  terminals: TerminalOption[];
  standaloneBerths: StandaloneBerthOption[];
};

type Message = {
  role: "user" | "assistant";
  content: string;
};

function contextLabel(args: {
  port: PortOption | null;
  terminalName: string | null;
  berthName: string | null;
}) {
  if (!args.port) return "No context selected";
  if (args.berthName && args.terminalName) {
    return `${args.port.name} → ${args.terminalName} → ${args.berthName}`;
  }
  if (args.berthName) {
    return `${args.port.name} → ${args.berthName}`;
  }
  if (args.terminalName) {
    return `${args.port.name} → ${args.terminalName}`;
  }
  return args.port.name;
}

export default function AIAssistant({
  ports,
  initialPortId,
  onHighlightPorts,
}: {
  ports: PortOption[];
  initialPortId?: number | null;
  onHighlightPorts: (ports: string[]) => void;
}) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        "Ask me anything about your Port DB, or use Summary overview with a selected port / terminal / berth.",
    },
  ]);
  const [assistantPortId, setAssistantPortId] = useState<number | null>(initialPortId ?? ports[0]?.id ?? null);
  const [assistantTerminalName, setAssistantTerminalName] = useState<string>("");
  const [assistantBerthName, setAssistantBerthName] = useState<string>("");
  const [assistantPortDetail, setAssistantPortDetail] = useState<AssistantPortDetail | null>(null);
  const [loadingPortDetail, setLoadingPortDetail] = useState(false);
  const [isAsking, setIsAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!assistantPortId) {
      setAssistantPortDetail(null);
      setAssistantTerminalName("");
      setAssistantBerthName("");
      return;
    }

    let cancelled = false;

    async function loadPortDetail() {
      setLoadingPortDetail(true);
      try {
        const res = await fetch(`/api/ports-v2?portId=${assistantPortId}`);
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error || "Failed to load assistant context.");
        }
        if (cancelled) return;

        setAssistantPortDetail({
          id: data.id,
          name: data.name,
          country: data.country,
          terminals: Array.isArray(data.terminals) ? data.terminals : [],
          standaloneBerths: Array.isArray(data.standaloneBerths) ? data.standaloneBerths : [],
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load assistant context.");
          setAssistantPortDetail(null);
        }
      } finally {
        if (!cancelled) setLoadingPortDetail(false);
      }
    }

    setError(null);
    loadPortDetail();

    return () => {
      cancelled = true;
    };
  }, [assistantPortId]);

  const selectedPort = useMemo(
    () => ports.find((port) => port.id === assistantPortId) ?? null,
    [ports, assistantPortId]
  );

  const terminalOptions = useMemo(
    () => assistantPortDetail?.terminals ?? [],
    [assistantPortDetail]
  );
  const selectedTerminal = useMemo(
    () => terminalOptions.find((terminal) => terminal.name === assistantTerminalName) ?? null,
    [terminalOptions, assistantTerminalName]
  );

  const berthOptions = useMemo(() => {
    if (selectedTerminal) return selectedTerminal.berths;
    return assistantPortDetail?.standaloneBerths ?? [];
  }, [selectedTerminal, assistantPortDetail]);

  const selectedContextLabel = contextLabel({
    port: selectedPort,
    terminalName: assistantTerminalName || null,
    berthName: assistantBerthName || null,
  });

  const portNames = useMemo(() => ports.map((port) => port.name), [ports]);

  const terminalToPort = useMemo(() => {
    const map = new Map<string, string>();
    for (const port of ports) {
      if (assistantPortDetail?.id === port.id) {
        for (const terminal of assistantPortDetail.terminals) {
          map.set(terminal.name.toLowerCase(), port.name);
        }
      }
    }
    return map;
  }, [ports, assistantPortDetail]);

  const detectMentionedPorts = (text: string) => {
    const lower = text.toLowerCase();
    const mentioned = new Set<string>();
    for (const portName of portNames) {
      if (portName && lower.includes(portName.toLowerCase())) mentioned.add(portName);
    }
    for (const [terminal, port] of terminalToPort) {
      if (terminal && lower.includes(terminal)) mentioned.add(port);
    }
    return Array.from(mentioned);
  };

  function resetLocationContext(nextPortId: number | null) {
    setAssistantPortId(nextPortId);
    setAssistantTerminalName("");
    setAssistantBerthName("");
  }

  function buildContextInstruction() {
    if (!selectedPort) {
      return "Use the whole database if no port is selected.";
    }

    if (assistantBerthName && assistantTerminalName) {
      return `Focus only on berth "${assistantBerthName}" inside terminal "${assistantTerminalName}" in port "${selectedPort.name}". Ignore all other ports, terminals, and berths unless explicitly asked to compare them.`;
    }

    if (assistantBerthName) {
      return `Focus only on berth "${assistantBerthName}" in port "${selectedPort.name}". Ignore all other ports and locations unless explicitly asked to compare them.`;
    }

    if (assistantTerminalName) {
      return `Focus only on terminal "${assistantTerminalName}" in port "${selectedPort.name}". Ignore all other ports and locations unless explicitly asked to compare them.`;
    }

    return `Focus only on port "${selectedPort.name}". Ignore all other ports unless explicitly asked to compare them.`;
  }

  async function ask(questionOverride?: string) {
    const q = (questionOverride ?? input).trim();
    if (!q) return;

    setError(null);
    setIsAsking(true);

    const contextualQuestion = `${buildContextInstruction()}\n\n${q}`;
    const nextMessages: Message[] = [...messages, { role: "user", content: q }];
    setMessages(nextMessages);

    try {
      const history = [
        ...messages.slice(1).map((m) => ({
          role: m.role,
          content: m.content,
        })),
        { role: "user" as const, content: contextualQuestion },
      ];

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

      const mentioned = detectMentionedPorts(answer);
      if (mentioned.length) onHighlightPorts(mentioned);
      else if (selectedPort) onHighlightPorts([selectedPort.name]);
    } catch (e) {
      console.error(e);
      setError("Unexpected error while asking the assistant.");
    } finally {
      setIsAsking(false);
    }
  }

  async function askSummaryOverview() {
    const scopeLabelText =
      assistantBerthName && assistantTerminalName
        ? `the selected berth`
        : assistantBerthName
          ? `the selected berth`
          : assistantTerminalName
            ? `the selected terminal`
            : `the selected port`;

    await ask(
      `Summary overview for ${scopeLabelText}.

Use this exact evidence-first structure:

1. Start with the key restriction and production categories only.
2. For each category, list repeated values with mention counts in this style:
   - 10.0 m — 4 mentions
   - 10.5 m — 12 mentions
   - 11.0 m — 3 mentions
3. Then show "Latest 5 mentions" for that category with value + date.
4. Only after that, add one short evidence note if useful.
5. Do not lead with a narrative paragraph.
6. Do not hide repeated values behind wording like "varies" when exact counts can be shown.
7. For draft/density/air draft/LOA/beam/DWT/rates/gangs/shifts, count the actual observed values and show the counts directly.`
    );
  }

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-lg">AI Port Assistant</h2>
          <div className="mt-1 text-xs text-slate-400">Assistant context: {selectedContextLabel}</div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-xs"
            onClick={() => {
              setMessages([
                {
                  role: "assistant",
                  content:
                    "Ask me anything about your Port DB, or use Summary overview with a selected port / terminal / berth.",
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

      <div className="grid gap-3 xl:grid-cols-[1.1fr_1fr_1fr_auto]">
        <select
          value={assistantPortId ?? ""}
          onChange={(e) => resetLocationContext(e.target.value ? Number(e.target.value) : null)}
          className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        >
          <option value="">Select port</option>
          {ports.map((port) => (
            <option key={port.id} value={port.id}>
              {port.name}{port.country ? `, ${port.country}` : ""}
            </option>
          ))}
        </select>

        <select
          value={assistantTerminalName}
          onChange={(e) => {
            setAssistantTerminalName(e.target.value);
            setAssistantBerthName("");
          }}
          disabled={!assistantPortId || loadingPortDetail || terminalOptions.length === 0}
          className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50"
        >
          <option value="">Port level</option>
          {terminalOptions.map((terminal) => (
            <option key={terminal.id} value={terminal.name}>
              {terminal.name}
            </option>
          ))}
        </select>

        <select
          value={assistantBerthName}
          onChange={(e) => setAssistantBerthName(e.target.value)}
          disabled={!assistantPortId || loadingPortDetail || berthOptions.length === 0}
          className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50"
        >
          <option value="">{assistantTerminalName ? "Terminal level" : "No berth selected"}</option>
          {berthOptions.map((berth) => (
            <option key={berth.id} value={berth.name}>
              {berth.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => void askSummaryOverview()}
          disabled={isAsking || !assistantPortId}
          className="inline-flex items-center justify-center px-4 py-2 rounded-md bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-sm font-medium text-slate-100"
        >
          Summary overview
        </button>
      </div>

      <div className="border border-slate-800 rounded-lg bg-slate-950 p-3 max-h-[320px] overflow-auto space-y-3 text-sm">
        {messages.map((m, idx) => (
          <div
            key={idx}
            className={m.role === "user" ? "text-slate-50" : "text-slate-200"}
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

      {error ? (
        <div className="text-sm text-red-400 border border-red-700/60 bg-red-950/40 px-3 py-2 rounded-md">
          {error}
        </div>
      ) : null}

      <div className="flex flex-col md:flex-row gap-3">
        <input
          className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
          placeholder='Ask: "Show latest draft mentions"'
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!isAsking) void ask();
            }
          }}
        />

        <button
          onClick={() => void ask()}
          disabled={isAsking}
          className="inline-flex items-center justify-center px-4 py-2 rounded-md bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 text-sm font-medium"
        >
          {isAsking ? "Thinking…" : "Ask"}
        </button>
      </div>

      <div className="text-xs text-slate-400">
        Use the selectors above to make the assistant work on a specific port, terminal, or berth without changing the rest of the page.
      </div>
    </section>
  );
}
