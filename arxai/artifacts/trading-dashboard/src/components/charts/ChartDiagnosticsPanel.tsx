import type { ChartIntelligenceResponse } from "@workspace/api-client-react";
import { Gauge, CheckCircle2, XCircle, AlertTriangle, Info } from "lucide-react";
import { relativeTime } from "@/lib/feed-confidence";

// ChartDiagnosticsPanel — Chart Brain v2 Admin Diagnostics mode body.
//
// Phase 2 additions: expanded safe-mode section showing the failure category,
// data source, candle count (barsAnalyzed), last candle time, latest price,
// validation failures (missing/duplicate/out-of-order/invalid), fast flags
// (momentumBurst/nearHigh/nearLow), and speed architecture.
//
// Operator-only: caller mounts this only for admin sessions that are NOT
// previewing as a user. PURE DISPLAY — no mutations, no dispatch. Only fields
// that exist on the real generated types are used here; never invented fields.

type ChartState = ChartIntelligenceResponse["state"];

function ms(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : `${Math.round(n)}ms`;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const decimals = abs < 10 ? 5 : abs < 1000 ? 3 : 2;
  return n.toFixed(decimals);
}

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(2)}%`;
}

// Quality → human-readable failure category. Never exposes internal gate names,
// raw error tokens, or any information that could aid account enumeration.
function qualityLabel(quality: string | null | undefined): { text: string; cls: string } {
  switch (quality) {
    case "invalid":
      return { text: "Data integrity failure (OHLC / mock-data check failed)", cls: "text-red-300" };
    case "stale":
      return { text: "Feed stale — trailing gap exceeds threshold", cls: "text-amber-300" };
    case "partial":
      return { text: "Incomplete sequence — missing / duplicate / out-of-order bars", cls: "text-amber-300" };
    case "delayed":
      return { text: "Feed delayed — not yet confirmed real-time", cls: "text-amber-300" };
    case "empty":
      return { text: "No candles returned by any provider", cls: "text-zinc-400" };
    case "unavailable":
      return { text: "No live feed provider reachable", cls: "text-zinc-400" };
    case "clean":
      return { text: "Feed clean — all integrity checks passed", cls: "text-emerald-300" };
    default:
      return { text: "Unknown quality state", cls: "text-zinc-500" };
  }
}

export function ChartDiagnosticsPanel({ state }: { state: ChartState | null }) {
  if (!state) {
    return (
      <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3 text-[11px] text-zinc-500">
        No state to diagnose yet.
      </div>
    );
  }

  const sp = state.speedState;
  const gates = state.marketUnderstanding.readiness.gates;
  const contradictions = state.marketUnderstanding.evidence.contradictions;
  const truth = state.truthState;
  const flags = state.fastFlags;
  const stats = state.candleStats;
  const qualityDegraded = truth.quality !== "clean";
  const failureCat = qualityLabel(truth.quality);

  return (
    <div
      className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3 text-[11px] leading-snug"
      data-testid="chart-diagnostics-panel"
    >
      <div className="flex items-center gap-2">
        <Gauge className="h-3.5 w-3.5 text-amber-400" />
        <span className="font-semibold text-zinc-200">Admin diagnostics</span>
        <span className="ml-auto text-[10px] text-zinc-500">operator-only</span>
      </div>

      {/* ── Phase 2 — Feed / Safe-Mode block ───────────────────────────── */}
      <div
        className={`mt-2 rounded border px-2 py-1.5 ${
          qualityDegraded
            ? "border-amber-500/30 bg-amber-950/20"
            : "border-emerald-500/20 bg-emerald-950/10"
        }`}
        data-testid="chart-diag-feed-summary"
      >
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
          {qualityDegraded ? (
            <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" />
          ) : (
            <Info className="h-3 w-3 shrink-0 text-emerald-400" />
          )}
          Feed / Safe-Mode
        </div>
        <div className="mt-1 space-y-0.5">
          <DiagRow label="Quality" value={truth.quality} />
          <DiagRow
            label="Failure category"
            value={<span className={failureCat.cls}>{failureCat.text}</span>}
          />
          <DiagRow label="Source" value={truth.source ?? "—"} />
          <DiagRow label="Timeframe" value={state.timeframe} />
          <DiagRow
            label="Candle count (bars)"
            value={stats.barsAnalyzed > 0 ? String(stats.barsAnalyzed) : "—"}
          />
          <DiagRow label="Last candle" value={relativeTime(truth.lastCandleTime)} />
          <DiagRow label="Latest price" value={fmtPrice(stats.lastClose)} />
          <DiagRow label="Feed latency" value={ms(truth.latencyMs)} />
          <DiagRow label="AI-usable" value={state.aiUsable ? "Yes" : "No"} />
          {truth.message && truth.message !== "Feed nominal" && (
            <DiagRow label="Message" value={<span className="text-amber-200">{truth.message}</span>} />
          )}
        </div>
      </div>

      {/* ── Phase 2 — Validation failures block ────────────────────────── */}
      <div className="mt-2" data-testid="chart-diag-validation">
        <div className="text-[10px] uppercase tracking-wide text-zinc-500">Validation failures</div>
        <div className="mt-1 grid grid-cols-2 gap-1 sm:grid-cols-4">
          <ValidationStat label="Invalid OHLC" value={truth.invalidOhlcCount} warnAbove={0} />
          <ValidationStat label="Missing bars" value={truth.missingCandleCount} warnAbove={0} />
          <ValidationStat label="Duplicates" value={truth.duplicateCount} warnAbove={0} />
          <ValidationStat label="Out-of-order" value={truth.outOfOrderCount} warnAbove={0} />
        </div>
      </div>

      {/* ── Phase 2 — Fast flags block ──────────────────────────────────── */}
      <div className="mt-2" data-testid="chart-diag-fast-flags">
        <div className="text-[10px] uppercase tracking-wide text-zinc-500">Fast flags</div>
        {!flags.populated ? (
          <div className="mt-1 text-zinc-500">Not enough candles to derive flags.</div>
        ) : (
          <div className="mt-1 grid grid-cols-3 gap-1">
            <FlagStat label="Momentum burst" active={flags.momentumBurst} />
            <FlagStat label="Near recent high" active={flags.nearRecentHigh} />
            <FlagStat label="Near recent low" active={flags.nearRecentLow} />
          </div>
        )}
        {flags.note && (
          <div className="mt-1 text-[10px] text-zinc-500">{flags.note}</div>
        )}
      </div>

      {/* ── Candle stats ─────────────────────────────────────────────────── */}
      {stats.barsAnalyzed > 0 && (
        <div className="mt-2" data-testid="chart-diag-candle-stats">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">Candle stats</div>
          <div className="mt-1 grid grid-cols-2 gap-1 sm:grid-cols-3">
            <Stat label="Direction" value={stats.direction} />
            <Stat label="Change %" value={pct(stats.changePct)} />
            <Stat label="Range" value={fmtPrice(stats.range)} />
            <Stat label="ATR" value={fmtPrice(stats.atr)} />
            <Stat label="Avg range" value={fmtPrice(stats.avgRange)} />
            <Stat label="Bars analyzed" value={String(stats.barsAnalyzed)} />
          </div>
        </div>
      )}

      {/* ── Speed architecture ───────────────────────────────────────────── */}
      <div className="mt-3 text-[10px] uppercase tracking-wide text-zinc-500">Speed architecture</div>
      <div className="mt-1 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        <Stat label="Brain" value={sp.brain} />
        <Stat label="Build time" value={ms(sp.stateBuildMs)} />
        <Stat label="Feed latency" value={ms(sp.feedLatencyMs)} />
        <Stat label="Slow-brain blocks live" value={sp.slowBrainBlockedLiveExecution ? "true" : "false"} />
        <Stat label="Active mode" value={sp.activeMode} />
        <Stat label="Slow-brain last run" value={sp.slowBrainLastRunAt ? relativeTime(sp.slowBrainLastRunAt) : "never"} />
      </div>

      {/* ── Readiness gates ──────────────────────────────────────────────── */}
      <div className="mt-3 text-[10px] uppercase tracking-wide text-zinc-500">
        Readiness gates ({state.marketUnderstanding.readiness.quality})
      </div>
      <div className="mt-1 space-y-1">
        {gates.length === 0 ? (
          <div className="text-zinc-500">No gates evaluated (insufficient data).</div>
        ) : (
          gates.map((g) => (
            <div
              key={g.key}
              className="flex items-start gap-1.5"
              data-testid={`chart-diag-gate-${g.key}`}
            >
              {g.passed ? (
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
              ) : (
                <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-rose-400" />
              )}
              <span className="text-zinc-400">
                <span className="text-zinc-300">{g.label}</span>{" "}
                <span className="text-zinc-600">({g.score})</span> — {g.detail}
              </span>
            </div>
          ))
        )}
      </div>

      {/* ── Contradictions ───────────────────────────────────────────────── */}
      {contradictions.length > 0 && (
        <>
          <div className="mt-3 text-[10px] uppercase tracking-wide text-zinc-500">Contradictions</div>
          <div className="mt-1 space-y-1">
            {contradictions.map((c, i) => (
              <div key={i} className="text-amber-300/90">
                [{c.severity}] {c.text}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 px-2 py-1">
      <div className="text-[9px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-[11px] font-medium text-zinc-300">{value}</div>
    </div>
  );
}

function DiagRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[10px]">
      <span className="shrink-0 text-zinc-500">{label}</span>
      <span className="text-right font-mono text-zinc-300">{value}</span>
    </div>
  );
}

function ValidationStat({ label, value, warnAbove }: { label: string; value: number; warnAbove: number }) {
  const warn = value > warnAbove;
  return (
    <div
      className={`rounded border px-2 py-1 ${warn ? "border-amber-500/40 bg-amber-950/20" : "border-zinc-800 bg-zinc-900/40"}`}
      data-testid={`chart-diag-val-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <div className="text-[9px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`text-[11px] font-medium ${warn ? "text-amber-300" : "text-zinc-500"}`}>
        {value}
      </div>
    </div>
  );
}

function FlagStat({ label, active }: { label: string; active: boolean }) {
  return (
    <div
      className={`rounded border px-2 py-1 ${active ? "border-blue-500/30 bg-blue-950/20" : "border-zinc-800 bg-zinc-900/40"}`}
    >
      <div className="text-[9px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`text-[11px] font-medium ${active ? "text-blue-300" : "text-zinc-600"}`}>
        {active ? "Yes" : "No"}
      </div>
    </div>
  );
}

export default ChartDiagnosticsPanel;
