// Calibration — trader-facing reliability diagram + Brier score.
//
// Reads GET /api/calibration/summary. For the selected fit it shows the
// reliability diagram of the SERVED probability (out-of-sample: predicted vs
// observed, N per bin) next to the raw score read as a percentage, and three
// Brier scores: served, base-rate forecast, and raw heuristic. Lower is
// better; a served Brier no better than the base rate means "no edge" and
// the card says so.

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface ReliabilityBinView {
  lo: number;
  hi: number;
  n: number;
  meanPredicted: number | null;
  observedRate: number | null;
}

export interface CalibrationFitView {
  fitKey: string;
  version: number;
  source: string;
  strategy: string;
  symbol: string;
  timeframe: string;
  status: "measured" | "unmeasured";
  model: string;
  n: number;
  baseRate: number | null;
  brier: number | null;
  brierBaseline: number | null;
  brierRaw: number | null;
  edgeDetected: boolean;
  reliability: ReliabilityBinView[];
  rawReliability: ReliabilityBinView[];
  fittedAt: string;
}

export interface CalibrationSummaryView {
  ok: boolean;
  minSample: number;
  measuredCount: number;
  edgeCount: number;
  lastRefitAt: string | null;
  fits: CalibrationFitView[];
}

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

async function getSummary(): Promise<CalibrationSummaryView> {
  const r = await fetch(`${BASE}/api/calibration/summary`, { credentials: "include" });
  if (!r.ok) throw new Error(`calibration summary ${r.status}`);
  return r.json();
}

const SOURCE_LABEL: Record<string, string> = {
  strategy_replay: "Strategy replay on stored candles",
  eleanor_outcomes: "Eleanor signal outcomes",
  scanner_outcomes: "Scanner signal outcomes",
};

export function fitTitle(f: CalibrationFitView): string {
  const strat = f.strategy.replace(/^strategy:/, "").replace(/_/g, " ");
  const sym = f.symbol === "*" ? "all markets" : f.symbol;
  const tf = f.timeframe === "*" ? "all timeframes" : f.timeframe;
  return `${strat} · ${sym} · ${tf}`;
}

export function brierVerdict(f: CalibrationFitView): string {
  if (f.status !== "measured" || f.brier == null || f.brierBaseline == null) {
    return `Unmeasured: ${f.n} graded outcomes.`;
  }
  if (f.edgeDetected) return "Beats the base rate out of sample: the score carries measured information.";
  return "No measured edge: the score does not beat the base rate, so the base rate is what is shown.";
}

export function ReliabilityDiagram({ fit }: { fit: CalibrationFitView }) {
  const W = 220;
  const H = 220;
  const pad = 24;
  const x = (p: number) => pad + p * (W - 2 * pad);
  const y = (p: number) => H - pad - p * (H - 2 * pad);
  const maxN = Math.max(1, ...fit.reliability.map((b) => b.n), ...fit.rawReliability.map((b) => b.n));
  const dot = (b: ReliabilityBinView, cls: string, key: string) =>
    b.n > 0 && b.meanPredicted != null && b.observedRate != null ? (
      <circle
        key={key}
        cx={x(b.meanPredicted)}
        cy={y(b.observedRate)}
        r={2 + 5 * Math.sqrt(b.n / maxN)}
        className={cls}
      >
        <title>{`predicted ${(b.meanPredicted * 100).toFixed(0)}% · observed ${(b.observedRate * 100).toFixed(0)}% · N=${b.n}`}</title>
      </circle>
    ) : null;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[260px]" role="img" aria-label="Reliability diagram" data-testid="calibration-reliability-diagram">
      <rect x={pad} y={pad} width={W - 2 * pad} height={H - 2 * pad} className="fill-none stroke-border" />
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} className="stroke-muted-foreground" strokeDasharray="3 3" />
      {fit.rawReliability.map((b, i) => dot(b, "fill-amber-500/50", `raw-${i}`))}
      {fit.reliability.map((b, i) => dot(b, "fill-sky-500", `cal-${i}`))}
      <text x={W / 2} y={H - 4} textAnchor="middle" className="fill-muted-foreground text-[9px]">predicted</text>
      <text x={8} y={H / 2} textAnchor="middle" transform={`rotate(-90 8 ${H / 2})`} className="fill-muted-foreground text-[9px]">observed</text>
    </svg>
  );
}

export function CalibrationFitDetail({ fit }: { fit: CalibrationFitView }) {
  const fmt = (v: number | null) => (v == null ? "—" : v.toFixed(3));
  return (
    <div className="flex flex-col sm:flex-row gap-3" data-testid="calibration-fit-detail">
      <ReliabilityDiagram fit={fit} />
      <div className="text-xs space-y-1 min-w-0">
        <div className="font-medium">{fitTitle(fit)}</div>
        <div className="text-muted-foreground">{SOURCE_LABEL[fit.source] ?? fit.source} · fit v{fit.version}</div>
        <div data-testid="calibration-fit-n">
          N = {fit.n} graded outcomes · base rate{" "}
          {fit.baseRate == null ? "unmeasured" : `${Math.round(fit.baseRate * 100)}%`}
        </div>
        <div className="grid grid-cols-3 gap-1 pt-1">
          <div className="border rounded p-1"><div className="text-muted-foreground">Brier (shown)</div><div className="font-mono" data-testid="calibration-brier">{fmt(fit.brier)}</div></div>
          <div className="border rounded p-1"><div className="text-muted-foreground">Base rate</div><div className="font-mono" data-testid="calibration-brier-baseline">{fmt(fit.brierBaseline)}</div></div>
          <div className="border rounded p-1"><div className="text-muted-foreground">Raw score</div><div className="font-mono" data-testid="calibration-brier-raw">{fmt(fit.brierRaw)}</div></div>
        </div>
        <div className="text-muted-foreground" data-testid="calibration-verdict">{brierVerdict(fit)}</div>
        <div className="text-[10px] text-muted-foreground">
          Blue: the probability shown in ARX (out-of-sample). Amber: the raw score read as a percentage. On the dashed line, predicted equals observed. Lower Brier is better.
        </div>
      </div>
    </div>
  );
}

// Self-contained fetch (no QueryClientProvider needed): the card is mounted
// inside pages that tests render without one.
type SummaryResult = Awaited<ReturnType<typeof getSummary>>;
const REFRESH_MS = 5 * 60_000;

function useCalibrationSummary() {
  const [state, setState] = useState<{ data?: SummaryResult; isLoading: boolean; isError: boolean }>({
    isLoading: true,
    isError: false,
  });
  useEffect(() => {
    let alive = true;
    const load = () =>
      getSummary().then(
        (data) => alive && setState({ data, isLoading: false, isError: false }),
        () => alive && setState((s) => ({ data: s.data, isLoading: false, isError: !s.data })),
      );
    void load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return state;
}

export function CalibrationReliabilityCard() {
  const q = useCalibrationSummary();
  const fits = useMemo(() => (q.data?.fits ?? []).filter((f) => f.n > 0), [q.data]);
  const [selected, setSelected] = useState<string | null>(null);
  const fit = fits.find((f) => f.fitKey === selected) ?? fits.find((f) => f.status === "measured") ?? fits[0];
  return (
    <Card data-testid="calibration-reliability-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">How accurate are the probabilities?</CardTitle>
        <CardDescription className="text-xs">
          Every probability ARX shows is measured on graded outcomes. Below the minimum sample it shows "unmeasured" with its N.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {q.isLoading && <div className="text-xs text-muted-foreground">Loading calibration…</div>}
        {q.isError && <div className="text-xs text-muted-foreground" data-testid="calibration-error">Calibration could not be loaded.</div>}
        {q.data && fits.length === 0 && (
          <div className="text-xs text-muted-foreground" data-testid="calibration-empty">
            No graded outcomes yet: every probability is unmeasured (minimum {q.data.minSample} graded outcomes).
          </div>
        )}
        {q.data && fits.length > 0 && (
          <>
            <div className="text-xs" data-testid="calibration-headline">
              {q.data.measuredCount} measured fit{q.data.measuredCount === 1 ? "" : "s"} · {q.data.edgeCount} with a measured edge over the base rate
            </div>
            <select
              className="w-full rounded border border-border bg-background p-1 text-xs"
              value={fit?.fitKey ?? ""}
              onChange={(e) => setSelected(e.target.value)}
              aria-label="Calibration fit"
            >
              {fits.map((f) => (
                <option key={f.fitKey} value={f.fitKey}>
                  {fitTitle(f)} — N={f.n}
                </option>
              ))}
            </select>
            {fit && <CalibrationFitDetail fit={fit} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}
