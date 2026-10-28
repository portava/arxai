import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  StrongestEdgeCard, WeakestAreaCard, EdgeBreakdownTable, EdgeWarningPanel,
  AiEdgeSummaryCard,
} from "@/components/edgeDiscovery";
import type { EdgeBehaviourBasis, EdgeReport, EdgeWarning } from "@/components/edgeDiscovery";

const GROUPS = ["symbol", "strategy", "emotion", "direction"] as const;

// Every read checks response.ok: an error body (401 session expired, 500)
// must surface as an error, never as an empty "Nothing flagged." result.
async function fetchEdgeJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  let body: unknown = null;
  try { body = await r.json(); } catch { body = null; }
  const err = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
    ? (body as { error: string }).error : null;
  if (!r.ok) throw new Error(err ?? `HTTP ${r.status}`);
  return body as T;
}

async function fetchReportList(url: string): Promise<{ reports: EdgeReport[] }> {
  const body = await fetchEdgeJson<{ reports?: unknown }>(url);
  if (!Array.isArray(body?.reports)) throw new Error("Response did not include a reports list.");
  return { reports: body.reports as EdgeReport[] };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function SectionStatus({ q, what }: { q: { isPending: boolean; isError: boolean; error: unknown }; what: string }) {
  if (q.isError) {
    return (
      <p className="rounded border border-dashed border-red-800 p-6 text-center text-xs text-red-300 md:col-span-2 lg:col-span-3" data-testid="edge-section-error">
        Could not load {what} ({errText(q.error)}). This is not an empty result.
      </p>
    );
  }
  return (
    <p className="rounded border border-dashed border-slate-700 p-6 text-center text-xs text-slate-500 md:col-span-2 lg:col-span-3">
      Loading {what}…
    </p>
  );
}

export default function EdgeDiscoveryPage() {
  const qc = useQueryClient();
  const [groupBy, setGroupBy] = useState<typeof GROUPS[number]>("symbol");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const reports = useQuery<{ reports: EdgeReport[] }>({
    queryKey: ["edge-reports"],
    queryFn: () => fetchReportList("/api/edge/reports?limit=100"),
  });
  const strongest = useQuery<{ reports: EdgeReport[] }>({
    queryKey: ["edge-strongest"],
    queryFn: () => fetchReportList("/api/edge/strongest"),
  });
  const weakest = useQuery<{ reports: EdgeReport[] }>({
    queryKey: ["edge-weakest"],
    queryFn: () => fetchReportList("/api/edge/weakest"),
  });
  const detail = useQuery<{ report: EdgeReport; warnings: EdgeWarning[]; behaviourBasis?: EdgeBehaviourBasis }>({
    queryKey: ["edge-detail", selectedId],
    enabled: selectedId != null,
    queryFn: () => fetchEdgeJson<{ report: EdgeReport; warnings: EdgeWarning[] }>(`/api/edge/reports/${selectedId}`),
  });

  const generate = useMutation({
    mutationFn: () => fetchEdgeJson<{ generated?: unknown }>("/api/edge/reports", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupBy }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["edge-reports"] });
      qc.invalidateQueries({ queryKey: ["edge-strongest"] });
      qc.invalidateQueries({ queryKey: ["edge-weakest"] });
    },
  });

  return (
    <div className="space-y-4 p-4">
      <header>
        <h1 className="text-xl font-semibold text-slate-100">Edge discovery</h1>
        <p className="text-xs text-slate-400">
          Where your own data shows a measurable edge — and where it doesn't yet.
          Past performance is not predictive. No setup is a "proven strategy."
        </p>
      </header>

      <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-400">Group by:</span>
          {GROUPS.map((g) => (
            <button key={g} onClick={() => setGroupBy(g)}
              className={`rounded px-2 py-0.5 text-[11px] font-semibold transition ${
                groupBy === g ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>
              {g}
            </button>
          ))}
          <div className="flex-1" />
          <button onClick={() => generate.mutate()} disabled={generate.isPending}
            className="rounded bg-violet-600 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-40">
            {generate.isPending ? "Analyzing…" : "Generate report"}
          </button>
        </div>
        {generate.isError && (
          <p className="mt-2 text-[11px] text-red-300" data-testid="edge-generate-error">
            Report generation failed ({errText(generate.error)}). No new slices were reported.
          </p>
        )}
        {generate.isSuccess && (
          <p className="mt-2 text-[11px] text-slate-400">
            {typeof generate.data?.generated === "number"
              ? `Generated ${generate.data.generated} slice(s).`
              : "Report request finished, but the server did not say how many slices were generated."}
          </p>
        )}
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-emerald-200">✓ Strongest edges</h2>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
          {!strongest.isSuccess && <SectionStatus q={strongest} what="strongest edges" />}
          {(strongest.data?.reports ?? []).slice(0, 6).map((r) => (
            <StrongestEdgeCard key={r.id} report={r} />
          ))}
          {strongest.isSuccess && strongest.data.reports.length === 0 && (
            <p className="rounded border border-dashed border-slate-700 p-6 text-center text-xs text-slate-500 md:col-span-2 lg:col-span-3">
              No strong edges yet — keep trading and journaling to build the sample.
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-red-200">⚠ Weakest areas</h2>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
          {!weakest.isSuccess && <SectionStatus q={weakest} what="weakest areas" />}
          {(weakest.data?.reports ?? []).slice(0, 6).map((r) => (
            <WeakestAreaCard key={r.id} report={r} />
          ))}
          {weakest.isSuccess && weakest.data.reports.length === 0 && (
            <p className="rounded border border-dashed border-slate-700 p-6 text-center text-xs text-slate-500 md:col-span-2 lg:col-span-3">
              Nothing flagged.
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-200">Latest slices{reports.isSuccess ? ` (${reports.data.reports.length})` : ""}</h2>
        <p className="mb-2 text-[11px] text-slate-500">Each slice shows its most recent generated report only; older runs of the same slice are not counted.</p>
        {reports.isSuccess
          ? <EdgeBreakdownTable reports={reports.data.reports} onSelect={(r) => setSelectedId(r.id)} />
          : <SectionStatus q={reports} what="slices" />}
      </section>

      {selectedId != null && detail.isError && (
        <p className="rounded border border-dashed border-red-800 p-3 text-xs text-red-300">
          Could not load that report ({errText(detail.error)}).
        </p>
      )}
      {detail.data && (
        <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <AiEdgeSummaryCard report={detail.data.report} behaviourBasis={detail.data.behaviourBasis} />
          <div>
            <h3 className="mb-1 text-sm font-semibold text-slate-200">Warnings</h3>
            <EdgeWarningPanel warnings={detail.data.warnings} />
          </div>
        </section>
      )}
    </div>
  );
}
