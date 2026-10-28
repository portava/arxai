// ScannerDataHealthPanel — plain-English "where is this chart data coming from
// and can I trust it?" card for the focused symbol/timeframe (Task #464).
//
// UI ONLY. Consumes the single shared scanner-truth contract
// (useScannerTruth → resolveScannerTruth) so it can NEVER disagree with the
// header strip, the chart, or Ruby about feed state. It exists to answer the
// GBPUSD question in user language: the data may be genuinely live, but it is
// ARX market data — NOT the broker's chart feed — and that distinction is shown
// honestly. A connected MT5 *execution* bridge never makes this card claim
// broker-live bars (brokerFeedActive is driven only by the candle source tier).
//
// Internal labels (provider IDs, aiUsable/feedStatus/mt5Provider/sourceTechnical
// tokens) are NEVER shown to normal users — they stay behind
// shouldShowAdminDiagnostics.

import { Activity, CheckCircle2, AlertTriangle, XCircle, Loader2 } from "lucide-react";
import { useChartSymbol, bareSymbol } from "@/lib/use-chart-symbol";
import { useScannerTimeframe } from "@/hooks/useScannerTimeframe";
import { useScannerTruth } from "@/hooks/useScannerTruth";
import { useTradingMode } from "@/hooks/useTradingMode";
import { cn } from "@/lib/utils";

export function ScannerDataHealthPanel() {
  const [symbol] = useChartSymbol();
  const bare = bareSymbol(symbol);
  const [timeframe] = useScannerTimeframe();
  const { truth, isError } = useScannerTruth(bare, timeframe);
  const { shouldShowAdminDiagnostics } = useTradingMode();

  // No truth and no failed request: the first candles response has not
  // arrived, so nothing was measured — a neutral "checking" state, never the
  // red XCircle used for a measured empty feed or a failed load.
  const pending = truth == null && isError !== true;
  const status = truth?.displayStatus ?? "UNAVAILABLE";
  const tone = pending
    ? "text-txt-muted"
    : status === "LIVE"
      ? "text-success"
      : status === "UNAVAILABLE"
        ? "text-danger"
        : "text-warning";

  const Icon = pending
    ? Loader2
    : status === "LIVE" ? CheckCircle2 : status === "UNAVAILABLE" ? XCircle : AlertTriangle;
  const headline = truth?.dataHealth.headline
    ?? (pending ? "Waiting for market data…" : "Market data could not be loaded — retrying.");

  return (
    <div
      className="rounded-2xl border border-border bg-card p-3 sm:p-4"
      data-testid="scanner-data-health"
    >
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
          <Activity className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-wide text-txt-muted">Data health</p>
          <p className={cn("flex items-center gap-1.5 text-sm font-semibold", tone)} data-testid="scanner-data-health-headline">
            <Icon className={cn("h-3.5 w-3.5 shrink-0", pending && "animate-spin")} />
            <span className="truncate">{headline}</span>
          </p>
        </div>
        <span className="shrink-0 font-mono text-xs text-txt-secondary">{symbol}</span>
      </div>

      {truth && (
        <ul className="mt-3 space-y-1.5">
          {truth.dataHealth.lines.map((line, i) => (
            <li
              key={i}
              className="flex items-start gap-1.5 text-[12px] leading-snug text-txt-secondary"
              data-testid="scanner-data-health-line"
            >
              <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-txt-muted" />
              <span className="min-w-0">{line}</span>
            </li>
          ))}
        </ul>
      )}

      {shouldShowAdminDiagnostics && truth && (
        <p className="mt-3 border-t border-border pt-2 text-[11px] text-txt-muted">
          source: {truth.candles.sourceTechnical} · tier {truth.candles.tier} · candles{" "}
          {truth.candles.count} loaded · {truth.candles.closedCount ?? truth.candles.count} closed · min {truth.candles.minRequired} closed · {truth.candles.status} ·
          brokerFeedActive={String(truth.brokerFeedActive)}
        </p>
      )}
    </div>
  );
}
