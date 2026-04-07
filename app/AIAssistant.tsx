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
  matchedPorts?: string[];
  matchedLocations?: {
    portName: string;
    terminalName?: string;
    berthName?: string;
  }[];
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

function groupLocationsByPort(
  locations: {
    portName: string;
    terminalName?: string;
    berthName?: string;
  }[]
) {
  const deduped = Array.from(
    new Map(
      locations.map((location) => [
        `${location.portName}__${location.terminalName ?? ""}__${location.berthName ?? ""}`,
        location,
      ])
    ).values()
  );

  const grouped = new Map<
    string,
    {
      portName: string;
      locations: {
        portName: string;
        terminalName?: string;
        berthName?: string;
      }[];
    }
  >();

  for (const location of deduped) {
    if (!grouped.has(location.portName)) {
      grouped.set(location.portName, {
        portName: location.portName,
        locations: [],
      });
    }
    grouped.get(location.portName)!.locations.push(location);
  }

  return Array.from(grouped.values()).map((group) => ({
    ...group,
    locations: group.locations.sort((a, b) => {
      const aLabel = a.berthName
        ? `${a.terminalName ?? ""} ${a.berthName}`
        : a.terminalName ?? a.portName;
      const bLabel = b.berthName
        ? `${b.terminalName ?? ""} ${b.berthName}`
        : b.terminalName ?? b.portName;
      return aLabel.localeCompare(bLabel);
    }),
  }));
}

function normalizeLabel(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function portGroupForLine(
  line: string,
  groups: ReturnType<typeof groupLocationsByPort>
) {
  const match = line.match(/^- ([^:]+):$/);
  if (!match) return null;
  const raw = match[1] ?? "";

  return (
    groups.find((group) => {
      const portName = group.portName;
      return (
        normalizeLabel(raw) === normalizeLabel(portName) ||
        normalizeLabel(raw).startsWith(`${normalizeLabel(portName)},`)
      );
    }) ?? null
  );
}

function locationLineForMatch(location: {
  portName: string;
  terminalName?: string;
  berthName?: string;
}) {
  if (location.berthName && location.terminalName) {
    if (normalizeLabel(location.terminalName) === normalizeLabel(location.portName)) {
      return `${location.portName} > ${location.berthName}`;
    }
    return `${location.terminalName} > ${location.berthName}`;
  }
  if (location.terminalName) {
    return location.terminalName;
  }
  return location.portName;
}

function locationMatchForLine(
  line: string,
  locations: {
    portName: string;
    terminalName?: string;
    berthName?: string;
  }[]
) {
  const normalizedLine = normalizeLabel(line);
  return (
    locations.find((location) => {
      const label = normalizeLabel(locationLineForMatch(location));
      return normalizedLine.includes(label);
    }) ?? null
  );
}

export default function AIAssistant({
  ports,
  initialPortId,
  onHighlightPorts,
  onOpenPort,
  onOpenLocation,
}: {
  ports: PortOption[];
  initialPortId?: number | null;
  onHighlightPorts: (ports: string[]) => void;
  onOpenPort: (portName: string) => void;
  onOpenLocation: (location: { portName: string; terminalName?: string; berthName?: string }) => void;
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

  function shouldUseGlobalScope(question: string) {
    const lower = question.toLowerCase();
    return (
      /\ball ports\b/.test(lower) ||
      /\bwhich ports\b/.test(lower) ||
      /\bwhat ports\b/.test(lower) ||
      /\bports where\b/.test(lower) ||
      /\bshow ports\b/.test(lower) ||
      /\bacross all ports\b/.test(lower) ||
      /\bcompare ports\b/.test(lower) ||
      /все порты/.test(lower) ||
      /какие порты/.test(lower) ||
      /порты где/.test(lower) ||
      /по всем портам/.test(lower) ||
      /среди портов/.test(lower)
    );
  }

  async function ask(questionOverride?: string) {
    const q = (questionOverride ?? input).trim();
    if (!q) return;

    setError(null);
    setIsAsking(true);

    const contextualQuestion = shouldUseGlobalScope(q)
      ? `Use the whole database for this question. Do not limit yourself to the currently selected port unless the user explicitly narrows the scope.\n\n${q}`
      : `${buildContextInstruction()}\n\n${q}`;
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

      const explicitHighlightedPorts = Array.isArray(data?.highlightedPorts)
        ? data.highlightedPorts.filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
      const matchedLocations = Array.isArray(data?.matchedLocations)
        ? data.matchedLocations.filter(
            (item: unknown): item is { portName: string; terminalName?: string; berthName?: string } =>
              Boolean(item) &&
              typeof item === "object" &&
              typeof (item as { portName?: unknown }).portName === "string"
          )
        : [];
      const answer = String(data?.answer || "").trim();
      const mentioned = detectMentionedPorts(answer);
      const assistantMsg: Message = {
        role: "assistant",
        content: answer || "(No answer returned.)",
        matchedPorts: explicitHighlightedPorts.length
          ? explicitHighlightedPorts
          : mentioned.length
            ? mentioned
            : selectedPort
              ? [selectedPort.name]
              : [],
        matchedLocations,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      setInput("");
      if (explicitHighlightedPorts.length) onHighlightPorts(explicitHighlightedPorts);
      else if (mentioned.length) onHighlightPorts(mentioned);
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

1. Cover every category that exists inside the selected context. Do not limit the summary only to restrictions or production if other categories are present.
2. For each category, list repeated values with mention counts in this style:
   - 10.0 m — 4 mentions
   - 10.5 m — 12 mentions
   - 11.0 m — 3 mentions
3. Then show "Latest 5 mentions" for that category with value + date.
4. Only after that, add one short evidence note if useful.
5. Do not lead with a narrative paragraph.
6. Do not hide repeated values behind wording like "varies" when exact counts can be shown.
7. For draft/density/air draft/LOA/beam/DWT/rates/gangs/shifts, count the actual observed values and show the counts directly.
8. If a category has only one observation, still include it briefly instead of skipping it.`
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
                {(() => {
                  const groupedLocations = groupLocationsByPort(m.matchedLocations ?? []);
                  return m.content.split("\n").map((line, i) => {
                    const inlineGroup = portGroupForLine(line, groupedLocations);
                    const inlineLocation = locationMatchForLine(line, m.matchedLocations ?? []);

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

                    return (
                      <div key={i} className="group space-y-2">
                        <div>{line}</div>
                        {inlineGroup ? (
                          <div className="flex max-h-0 flex-wrap items-center gap-2 overflow-hidden pl-2 opacity-0 transition-all duration-150 group-hover:max-h-40 group-hover:opacity-100">
                            <button
                              type="button"
                              onClick={() => onOpenPort(inlineGroup.portName)}
                              className="rounded-full border border-[color:rgba(113,194,183,0.38)] bg-[color:rgba(113,194,183,0.14)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--accent-soft)] transition hover:bg-[color:rgba(113,194,183,0.22)]"
                            >
                              {inlineGroup.portName}
                            </button>
                            {inlineGroup.locations
                              .filter((location) => location.terminalName || location.berthName)
                              .map((location, locationIndex) => {
                                const label = location.berthName
                                  ? `${location.terminalName ?? "Berth"} → ${location.berthName}`
                                  : `${location.terminalName}`;

                                return (
                                  <button
                                    key={`${i}-${inlineGroup.portName}-${locationIndex}-${label}`}
                                    type="button"
                                    onClick={() => onOpenLocation(location)}
                                    className="rounded-full border border-[color:rgba(124,150,196,0.22)] bg-[color:rgba(124,150,196,0.06)] px-2.5 py-1 text-[9px] uppercase tracking-[0.14em] text-[color:#b9c7ef] transition hover:bg-[color:rgba(124,150,196,0.14)]"
                                  >
                                    {label}
                                  </button>
                                );
                              })}
                          </div>
                        ) : null}
                        {!inlineGroup && inlineLocation ? (
                          <div className="flex max-h-0 flex-wrap items-center gap-2 overflow-hidden pl-2 opacity-0 transition-all duration-150 group-hover:max-h-20 group-hover:opacity-100">
                            <button
                              type="button"
                              onClick={() => onOpenLocation(inlineLocation)}
                              className="rounded-full border border-[color:rgba(124,150,196,0.24)] bg-[color:rgba(124,150,196,0.08)] px-2.5 py-1 text-[9px] uppercase tracking-[0.14em] text-[color:#b9c7ef] transition hover:bg-[color:rgba(124,150,196,0.16)]"
                            >
                              {inlineLocation.berthName
                                ? `Open ${inlineLocation.terminalName ?? inlineLocation.portName} → ${inlineLocation.berthName}`
                                : `Open ${inlineLocation.terminalName ?? inlineLocation.portName}`}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    );
                  });
                })()}
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
