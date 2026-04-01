"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  LocationEntityType,
  LocationMatchMethod,
  LocationMatchStatus,
  MatchConfidence,
} from "@prisma/client";

type ReviewLog = {
  id: number;
  createdAt: string;
  entityType: LocationEntityType;
  rawName: string;
  normalizedName: string;
  matchedName: string | null;
  method: LocationMatchMethod;
  confidence: MatchConfidence;
  status: LocationMatchStatus;
  reason: string | null;
  port: { id: number; name: string };
  terminal: { id: number; name: string } | null;
  berth: { id: number; name: string } | null;
  sourceRecord: {
    id: number;
    sourceName: string | null;
    sourceDate: string | null;
    rawText: string;
  } | null;
};

type ReviewQueueProps = {
  logs: ReviewLog[];
};

function confidenceTone(confidence: MatchConfidence) {
  switch (confidence) {
    case MatchConfidence.HIGH:
      return "border-[color:rgba(113,194,183,0.24)] bg-[color:rgba(113,194,183,0.08)] text-[color:var(--accent-soft)]";
    case MatchConfidence.MEDIUM:
      return "border-[color:rgba(211,122,51,0.28)] bg-[color:rgba(211,122,51,0.1)] text-[color:var(--alert)]";
    default:
      return "border-[color:rgba(197,79,63,0.3)] bg-[color:rgba(197,79,63,0.1)] text-[color:var(--danger)]";
  }
}

function statusTone(status: LocationMatchStatus) {
  switch (status) {
    case LocationMatchStatus.MATCHED:
      return "border-[color:rgba(113,194,183,0.24)] bg-[color:rgba(113,194,183,0.08)] text-[color:var(--accent-soft)]";
    case LocationMatchStatus.CREATED_NEW:
      return "border-[color:rgba(124,150,196,0.24)] bg-[color:rgba(124,150,196,0.1)] text-[color:#b9c7ef]";
    default:
      return "border-[color:rgba(211,122,51,0.28)] bg-[color:rgba(211,122,51,0.1)] text-[color:var(--alert)]";
  }
}

function methodLabel(method: LocationMatchMethod) {
  return method.replaceAll("_", " ").toLowerCase();
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function ReviewQueue({ logs }: ReviewQueueProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [activeLogId, setActiveLogId] = useState<number | null>(null);

  const queue = logs.filter(
    (log) =>
      log.status === LocationMatchStatus.NEEDS_REVIEW ||
      log.confidence === MatchConfidence.LOW
  );

  const grouped = {
    needsReview: queue.filter((log) => log.status === LocationMatchStatus.NEEDS_REVIEW),
    lowConfidence: queue.filter((log) => log.confidence === MatchConfidence.LOW),
  };

  function runAction(logId: number, action: "confirm" | "create-separate" | "promote-alias") {
    setError(null);
    setActiveLogId(logId);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/location-match-logs/${logId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });

        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          throw new Error(data.error || "Review action failed.");
        }

        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Review action failed.");
      } finally {
        setActiveLogId(null);
      }
    });
  }

  return (
    <section className="mt-4 grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="rounded-[28px] border border-[color:var(--line-strong)] bg-[color:rgba(8,24,33,0.82)] p-5">
        <div className="text-[11px] uppercase tracking-[0.28em] text-[color:var(--ink-muted)]">Queue Summary</div>
        <h2 className="mt-2 text-xl font-semibold text-[color:var(--ink-main)]">What to inspect first</h2>
        <div className="mt-5 space-y-3">
          <div className="rounded-[22px] border border-[color:rgba(211,122,51,0.28)] bg-[color:rgba(211,122,51,0.08)] p-4">
            <div className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">AI medium confidence</div>
            <div className="mt-2 text-2xl font-semibold text-[color:var(--alert)]">{grouped.needsReview.length}</div>
          </div>
          <div className="rounded-[22px] border border-[color:rgba(197,79,63,0.28)] bg-[color:rgba(197,79,63,0.08)] p-4">
            <div className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">Low confidence</div>
            <div className="mt-2 text-2xl font-semibold text-[color:var(--danger)]">{grouped.lowConfidence.length}</div>
          </div>
          <div className="rounded-[22px] border border-[color:rgba(113,194,183,0.22)] bg-[color:rgba(113,194,183,0.08)] p-4">
            <div className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">Auto-resolved hidden</div>
            <div className="mt-2 text-2xl font-semibold text-[color:var(--accent-soft)]">{logs.length - queue.length}</div>
          </div>
        </div>

        {error ? (
          <div className="mt-4 rounded-[18px] border border-[color:rgba(197,79,63,0.28)] bg-[color:rgba(197,79,63,0.08)] px-4 py-3 text-sm text-[color:var(--danger)]">
            {error}
          </div>
        ) : null}
      </aside>

      <main className="rounded-[28px] border border-[color:var(--line-strong)] bg-[color:rgba(8,24,33,0.82)] p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-[color:var(--ink-muted)]">Recent decisions</div>
            <h2 className="mt-2 text-xl font-semibold text-[color:var(--ink-main)]">Location match ledger</h2>
          </div>
          <div className="rounded-full border border-[color:var(--line-soft)] px-3 py-1 text-xs text-[color:var(--ink-soft)]">
            {logs.length} rows
          </div>
        </div>

        {queue.length === 0 ? (
          <p className="mt-6 text-sm text-[color:var(--ink-soft)]">No location resolution logs yet.</p>
        ) : (
          <div className="mt-5 space-y-3">
            {queue.map((log) => {
              const busy = isPending && activeLogId === log.id;

              return (
                <article
                  key={log.id}
                  className="rounded-[22px] border border-[color:var(--line-soft)] bg-[color:rgba(7,24,32,0.74)] p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.22em] text-[color:var(--ink-muted)]">
                        {log.entityType === LocationEntityType.TERMINAL ? "Terminal" : "Berth"} · {log.port.name}
                      </div>
                      <div className="mt-2 text-lg font-semibold text-[color:var(--ink-main)]">
                        {log.rawName}
                      </div>
                      <div className="mt-1 text-sm text-[color:var(--ink-soft)]">
                        {log.matchedName
                          ? `Matched to ${log.matchedName}`
                          : "No resolved entity attached yet"}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs uppercase tracking-[0.16em]">
                      <span className={`rounded-full border px-2.5 py-1 ${statusTone(log.status)}`}>
                        {log.status.replaceAll("_", " ")}
                      </span>
                      <span className={`rounded-full border px-2.5 py-1 ${confidenceTone(log.confidence)}`}>
                        {log.confidence}
                      </span>
                      <span className="rounded-full border border-[color:var(--line-soft)] px-2.5 py-1 text-[color:var(--ink-soft)]">
                        {methodLabel(log.method)}
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1fr]">
                    <div className="rounded-[18px] bg-[color:rgba(8,22,30,0.82)] p-3 text-sm text-[color:var(--ink-soft)]">
                      <div className="text-[11px] uppercase tracking-[0.2em] text-[color:var(--ink-muted)]">Why</div>
                      <div className="mt-2">{log.reason || "No explicit reason captured."}</div>
                      <div className="mt-3 text-xs uppercase tracking-[0.16em] text-[color:var(--ink-muted)]">
                        Normalized key: {log.normalizedName}
                      </div>
                    </div>
                    <div className="rounded-[18px] bg-[color:rgba(8,22,30,0.82)] p-3 text-sm text-[color:var(--ink-soft)]">
                      <div className="text-[11px] uppercase tracking-[0.2em] text-[color:var(--ink-muted)]">Context</div>
                      <div className="mt-2 space-y-1">
                        <div>Created: {formatDate(log.createdAt)}</div>
                        <div>Source: {log.sourceRecord?.sourceName || "Unknown source"}</div>
                        <div>
                          Source date:{" "}
                          {log.sourceRecord?.sourceDate ? formatDate(log.sourceRecord.sourceDate) : "Unknown"}
                        </div>
                        <div>Terminal entity: {log.terminal?.name || "None"}</div>
                        <div>Berth entity: {log.berth?.name || "None"}</div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => runAction(log.id, "confirm")}
                      className="rounded-full border border-[color:rgba(113,194,183,0.28)] px-3 py-2 text-xs uppercase tracking-[0.16em] text-[color:var(--accent-soft)] transition hover:bg-[color:rgba(113,194,183,0.08)] disabled:opacity-50"
                    >
                      Confirm match
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => runAction(log.id, "promote-alias")}
                      className="rounded-full border border-[color:rgba(124,150,196,0.26)] px-3 py-2 text-xs uppercase tracking-[0.16em] text-[color:#b9c7ef] transition hover:bg-[color:rgba(124,150,196,0.08)] disabled:opacity-50"
                    >
                      Promote alias
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => runAction(log.id, "create-separate")}
                      className="rounded-full border border-[color:rgba(211,122,51,0.28)] px-3 py-2 text-xs uppercase tracking-[0.16em] text-[color:var(--alert)] transition hover:bg-[color:rgba(211,122,51,0.08)] disabled:opacity-50"
                    >
                      Create separate entity
                    </button>
                  </div>

                  {log.sourceRecord?.rawText ? (
                    <div className="mt-4 rounded-[18px] border border-[color:rgba(113,194,183,0.12)] bg-[color:rgba(7,20,28,0.74)] p-3">
                      <div className="text-[11px] uppercase tracking-[0.2em] text-[color:var(--ink-muted)]">Source excerpt</div>
                      <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm leading-6 text-[color:var(--ink-soft)]">
                        {log.sourceRecord.rawText}
                      </p>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </main>
    </section>
  );
}
