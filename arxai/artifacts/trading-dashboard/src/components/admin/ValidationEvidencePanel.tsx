// Admin research surface: real-data validation evidence (read-only).
//
// Shows the newest stored run of the real-data validation lane exactly as the
// server verified it: dataset hash, code commit, the number of tests the
// multiple-testing correction was charged for, the honesty checks, and every
// instrument × family row. Zero survivors is shown as a finding, not hidden;
// a family that never traded is "not searched", never "no edge". There is no
// promote/approve control here — survivors are SHADOW proposals at most.
//
// One section per dataset source (daily fixture, Deriv intraday fixture, stored
// MT5 bars, gross-of-costs diagnostics…), each showing that source's newest
// run, with its rows grouped by timeframe (M1/M5/M15/H1; daily runs are D1).

import { useQuery } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const apiFetch = (url: string) => fetch(url, { credentials: "include" }).then((r) => r.json());

export interface EvidenceManifest {
  id: string; datasetSource: string; datasetHash: string; paramsHash: string; resultHash: string;
  codeCommit: string; codeDirty: boolean; trials: number; survivors: number; recordedAt: string;
  liveAllowed: false; promotionCeiling: "SHADOW";
}
export interface SummaryRow {
  symbol: string; familyKey: string; variants: number; activeVariants: number; survivors: number;
  bestAnnualisedSharpe: number; bestDsr: number; pbo: number | string; walkForwardAnnualisedSharpe: number;
  walkForwardSurvivor: boolean; rangesDerived: boolean; timeframe?: string;
}
interface RunDetail {
  summary: SummaryRow[];
  survivors: Array<{ key: string; annualisedSharpe: number; dsr: number; pValue: number; promotionCeiling: string; liveAllowed: boolean }>;
  fdr: { q: number; familySize: number; rejections: number };
  checks: { cpcvSplitsChecked: number; cpcvViolations: number; walkForwardFoldsChecked: number; walkForwardViolations: number;
    lookaheadVariantsChecked: number; lookaheadViolations: string[] };
}

/** Status word for one instrument × family row. Never "no edge" for a family that was not searched. */
export function rowStatus(r: SummaryRow): string {
  if (r.activeVariants === 0) return "Not searched — never traded";
  if (r.survivors > 0 || r.walkForwardSurvivor) return "Survived — SHADOW proposal only";
  return "Rejected";
}

const TIMEFRAME_ORDER = ["M1", "M5", "M15", "H1", "D1"];

/** Rows grouped by timeframe, in M1→D1 order; rows without a timeframe are daily (D1). */
export function groupByTimeframe(rows: readonly SummaryRow[]): Array<{ timeframe: string; rows: SummaryRow[] }> {
  const groups = new Map<string, SummaryRow[]>();
  for (const r of rows) {
    const tf = r.timeframe ?? "D1";
    groups.set(tf, [...(groups.get(tf) ?? []), r]);
  }
  const rank = (tf: string) => { const i = TIMEFRAME_ORDER.indexOf(tf); return i < 0 ? TIMEFRAME_ORDER.length : i; };
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])).map(([timeframe, rows]) => ({ timeframe, rows }));
}

/** Newest manifest per dataset source; `items` arrive newest-first from the server. */
export function latestPerSource(items: ReadonlyArray<{ manifest: EvidenceManifest }>): EvidenceManifest[] {
  const seen = new Set<string>();
  const out: EvidenceManifest[] = [];
  for (const { manifest } of items) {
    if (seen.has(manifest.datasetSource)) continue;
    seen.add(manifest.datasetSource);
    out.push(manifest);
  }
  return out;
}

const fmt = (x: unknown, d = 2) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(d) : "—");

function RunSection({ latest }: { latest: EvidenceManifest }) {
  const detail = useQuery({
    queryKey: ["admin", "research", "validation-evidence", latest.id],
    queryFn: () => apiFetch(`/api/admin/research/validation-evidence/${latest.id}`),
    enabled: Boolean(latest.id),
  });
  const run = (detail.data?.ok ? detail.data.run : null) as RunDetail | null;
  return (
    <section className="space-y-2" data-testid="validation-evidence-run" data-source={latest.datasetSource}>
      <div className="flex flex-wrap gap-2 items-center">
        <Badge variant="outline" data-testid="validation-evidence-survivors">
          {latest.survivors === 0 ? "0 survivors" : `${latest.survivors} survivor(s) — SHADOW only`} of {latest.trials} tests
        </Badge>
        <span className="text-muted-foreground">
          {latest.datasetSource} · dataset {latest.datasetHash.slice(0, 12)} · commit {latest.codeCommit.slice(0, 10)}
          {latest.codeDirty ? " (dirty tree)" : ""} · {new Date(latest.recordedAt).toLocaleString()}
        </span>
      </div>
      {detail.data && detail.data.ok === false ? (
        <div className="text-danger" data-testid="validation-evidence-integrity">
          {String(detail.data.message ?? detail.data.error)}
        </div>
      ) : run ? (
        <>
          <div className="text-muted-foreground" data-testid="validation-evidence-checks">
            BH q={run.fdr.q} over m={run.fdr.familySize}: {run.fdr.rejections} certified · CPCV splits {run.checks.cpcvSplitsChecked}
            {" "}(leaks {run.checks.cpcvViolations}) · walk-forward folds {run.checks.walkForwardFoldsChecked}
            {" "}(leaks {run.checks.walkForwardViolations}) · lookahead checks {run.checks.lookaheadVariantsChecked}
            {" "}(violations {run.checks.lookaheadViolations.length})
          </div>
          {groupByTimeframe(run.summary).map((g) => {
            const survivors = g.rows.reduce((a, r) => a + r.survivors + (r.walkForwardSurvivor ? 1 : 0), 0);
            return (
              <div key={g.timeframe} className="overflow-x-auto" data-testid={`validation-evidence-tf-${g.timeframe}`}>
                <div className="font-medium pt-1">
                  {g.timeframe} · {new Set(g.rows.map((r) => r.symbol)).size} series · {survivors === 0 ? "0 survivors" : `${survivors} survivor(s) — SHADOW only`}
                </div>
                <table className="w-full text-left">
                  <thead className="text-muted-foreground">
                    <tr><th>Instrument</th><th>Family</th><th>Active</th><th>Best ann. SR</th><th>Best DSR</th><th>PBO</th><th>WF ann. SR</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {g.rows.map((r) => (
                      <tr key={`${r.symbol}:${r.familyKey}`} className="border-t">
                        <td>{r.symbol}</td><td>{r.familyKey}</td><td>{r.activeVariants}/{r.variants}</td>
                        <td>{fmt(r.bestAnnualisedSharpe)}</td><td>{fmt(r.bestDsr, 3)}</td><td>{fmt(r.pbo)}</td>
                        <td>{fmt(r.walkForwardAnnualisedSharpe)}</td>
                        <td>{rowStatus(r)}{r.rangesDerived && r.activeVariants > 0 ? " (close-only: ranges derived)" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </>
      ) : (
        <div className="text-muted-foreground">Loading run…</div>
      )}
    </section>
  );
}

export function ValidationEvidencePanel() {
  const list = useQuery({
    queryKey: ["admin", "research", "validation-evidence"],
    queryFn: () => apiFetch("/api/admin/research/validation-evidence"),
  });
  const latest = latestPerSource((list.data?.items ?? []) as Array<{ manifest: EvidenceManifest }>);

  return (
    <Card data-testid="validation-evidence-panel">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2"><FlaskConical className="h-4 w-4" />Real-data validation evidence</CardTitle>
        <CardDescription className="text-xs">
          Every strategy family over hashed real history — daily and the intraday Deriv feeds ARX trades: walk-forward,
          purged CPCV, Deflated Sharpe, PBO and one family-wide FDR pass. Survivors are SHADOW proposals at most;
          nothing here can allow live trading.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-xs">
        {list.isLoading ? (
          <div className="text-muted-foreground">Loading evidence…</div>
        ) : list.data && list.data.ok === false ? (
          <div className="text-muted-foreground" data-testid="validation-evidence-unavailable">
            Unavailable: {String(list.data.message ?? list.data.error)}
          </div>
        ) : latest.length === 0 ? (
          <div className="text-muted-foreground">No validation runs stored yet.</div>
        ) : (
          latest.map((m) => <RunSection key={m.id} latest={m} />)
        )}
      </CardContent>
    </Card>
  );
}
