import Link from "next/link";
import ReviewQueue from "./ReviewQueue";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const logs = await prisma.locationMatchLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 150,
    include: {
      port: true,
      terminal: true,
      berth: true,
      sourceRecord: {
        select: {
          id: true,
          sourceName: true,
          sourceDate: true,
          rawText: true,
        },
      },
    },
  });

  const queue = logs.filter(
    (log) => log.status === "NEEDS_REVIEW" || log.confidence === "LOW"
  );
  const createdNewCount = logs.filter((log) => log.status === "CREATED_NEW").length;

  return (
    <div className="min-h-screen bg-[color:var(--base)] text-[color:var(--ink-main)]">
      <div className="pointer-events-none fixed inset-0 opacity-70">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(113,194,183,0.14),transparent_30%),radial-gradient(circle_at_top_right,rgba(211,122,51,0.14),transparent_24%),linear-gradient(180deg,rgba(4,19,28,0.96),rgba(5,14,21,1))]" />
      </div>

      <div className="relative mx-auto max-w-[1480px] px-4 py-4 lg:px-6">
        <header className="overflow-hidden rounded-[32px] border border-[color:var(--line-strong)] bg-[color:rgba(8,28,39,0.82)] shadow-[0_24px_80px_rgba(2,8,12,0.36)]">
          <div className="grid gap-6 px-6 py-6 lg:grid-cols-[1.2fr_0.8fr] lg:px-8 lg:py-7">
            <div>
              <p className="text-[11px] uppercase tracking-[0.38em] text-[color:var(--ink-muted)]">
                Location Resolution Review
              </p>
              <h1 className="mt-3 max-w-3xl font-serif text-4xl leading-tight text-[color:var(--ink-main)] lg:text-5xl">
                Audit only the ambiguous cases where the system wants a second pair of eyes.
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-[color:var(--ink-soft)] lg:text-[15px]">
                High-confidence matches stay automatic. This queue is for medium-confidence and low-confidence cases where human review is actually useful.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-[24px] border border-[color:var(--line-soft)] bg-[color:rgba(7,24,32,0.82)] p-4">
                <div className="text-[11px] uppercase tracking-[0.24em] text-[color:var(--ink-muted)]">Needs Review</div>
                <div className="mt-3 text-3xl font-semibold text-[color:var(--alert)]">{queue.length}</div>
              </div>
              <div className="rounded-[24px] border border-[color:var(--line-soft)] bg-[color:rgba(7,24,32,0.82)] p-4">
                <div className="text-[11px] uppercase tracking-[0.24em] text-[color:var(--ink-muted)]">Created New</div>
                <div className="mt-3 text-3xl font-semibold text-[color:#b9c7ef]">{createdNewCount}</div>
              </div>
              <Link
                href="/"
                className="rounded-[24px] border border-[color:rgba(113,194,183,0.28)] bg-[linear-gradient(135deg,rgba(113,194,183,0.2),rgba(45,86,104,0.2))] p-4 text-left transition hover:border-[color:rgba(113,194,183,0.48)] hover:bg-[linear-gradient(135deg,rgba(113,194,183,0.28),rgba(45,86,104,0.22))]"
              >
                <div className="text-[11px] uppercase tracking-[0.24em] text-[color:var(--ink-muted)]">Return</div>
                <div className="mt-3 text-xl font-semibold text-[color:var(--ink-main)]">Back to Console</div>
                <div className="mt-2 text-sm text-[color:var(--ink-soft)]">
                  Jump back into the port dossier and ingest flow.
                </div>
              </Link>
            </div>
          </div>
        </header>

        <ReviewQueue
          logs={logs.map((log) => ({
            ...log,
            createdAt: log.createdAt.toISOString(),
            sourceRecord: log.sourceRecord
              ? {
                  ...log.sourceRecord,
                  sourceDate: log.sourceRecord.sourceDate?.toISOString() ?? null,
                }
              : null,
          }))}
        />
      </div>
    </div>
  );
}
