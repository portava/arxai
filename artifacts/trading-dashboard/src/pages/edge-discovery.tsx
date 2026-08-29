import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  StrongestEdgeCard, WeakestAreaCard, EdgeBreakdownTable, EdgeWarningPanel,
  AiEdgeSummaryCard,
} from "@/components/edgeDiscovery";
import type { EdgeReport, EdgeWarning } from "@/components/edgeDiscovery";

const GROUPS = ["symbol", "strategy", "emotion", "direction"] as const;

export default function EdgeDiscoveryPage() {
  const qc = useQueryClient();
  const [groupBy, setGroupBy] = useState<typeof GROUPS[number]>("symbol");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const reports = useQuery<{ reports: EdgeReport[] }>({
    queryKey: ["edge-reports"],
    queryFn: async () => (await fetch("/api/edge/reports?limit=100")).json(),
  });
  const strongest = useQuery<{ reports: EdgeReport[] }>({
    queryKey: ["edge-strongest"],
    queryFn: async () => (await fetch("/api/edge/strongest")).json(),
  });
  const weakest = useQuery<{ reports: EdgeReport[] }>({
    queryKey: ["edge-weakest"],
    queryFn: async () => (await fetch("/api/edge/weakest")).json(),
  });
  const detail = useQuery<{ report: EdgeReport; warnings: EdgeWarning[] }>({
    queryKey: ["edge-detail", selectedId],
    enabled: selectedId != null,
    queryFn: async () => (await fetch(`/api/edge/reports/${selectedId}`)).json(),
  });

  const generate = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/edge/reports", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ groupBy }),
      });
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["edge-reports"] });
      qc.invalidateQueries({ queryKey: ["edge-strongest"] });
      qc.invalidateQueries({ queryKey: ["edge-weakest"] });
    },
  });

  return (
    <div className="space-y-4 p-4">
      <header>
        <h1 className="text-xl font-semibold text-foreground">Edge discovery</h1>
        <p className="text-xs text-txt-secondary">
          Where your own data shows a measurable edge — and where it doesn't yet.
          Past performance is not predictive. No setup is a "proven strategy."
        </p>
      </header>

      <div className="rounded-lg border border-border bg-muted/40 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-txt-secondary">Group by:</span>
          {GROUPS.map((g) => (
            <button key={g} onClick={() => setGroupBy(g)}
              className={`rounded px-2 py-0.5 text-[11px] font-semibold transition ${
                groupBy === g ? "bg-sky-600 text-white" : "bg-secondary text-txt-secondary hover:bg-muted"}`}>
              {g}
            </button>
          ))}
          <div className="flex-1" />
          <button onClick={() => generate.mutate()} disabled={generate.isPending}
            className="rounded bg-premium px-3 py-1 text-xs font-semibold text-white hover:bg-premium disabled:opacity-40">
            {generate.isPending ? "Analyzing…" : "Generate report"}
          </button>
        </div>
        {generate.data && (
          <p className="mt-2 text-[11px] text-txt-secondary">Generated {generate.data.generated ?? 0} slice(s).</p>
        )}
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-success">✓ Strongest edges</h2>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
          {(strongest.data?.reports ?? []).slice(0, 6).map((r) => (
            <StrongestEdgeCard key={r.id} report={r} />
          ))}
          {(strongest.data?.reports.length ?? 0) === 0 && (
            <p className="rounded border border-dashed border-border p-6 text-center text-xs text-txt-muted md:col-span-2 lg:col-span-3">
              No strong edges yet — keep trading and journaling to build the sample.
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-red-200">⚠ Weakest areas</h2>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
          {(weakest.data?.reports ?? []).slice(0, 6).map((r) => (
            <WeakestAreaCard key={r.id} report={r} />
          ))}
          {(weakest.data?.reports.length ?? 0) === 0 && (
            <p className="rounded border border-dashed border-border p-6 text-center text-xs text-txt-muted md:col-span-2 lg:col-span-3">
              Nothing flagged.
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-foreground">All slices ({reports.data?.reports.length ?? 0})</h2>
        <EdgeBreakdownTable reports={reports.data?.reports ?? []} onSelect={(r) => setSelectedId(r.id)} />
      </section>

      {detail.data && (
        <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <AiEdgeSummaryCard report={detail.data.report} />
          <div>
            <h3 className="mb-1 text-sm font-semibold text-foreground">Warnings</h3>
            <EdgeWarningPanel warnings={detail.data.warnings} />
          </div>
        </section>
      )}
    </div>
  );
}
