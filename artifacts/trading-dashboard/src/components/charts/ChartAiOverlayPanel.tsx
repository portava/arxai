import { Button } from "@/components/ui/button";
import { Sparkles, Loader2, Radar, ShieldOff } from "lucide-react";
import type { UseAiChartOverlaysResult } from "@/hooks/useAiChartOverlays";
import { useAssistantName } from "@/lib/assistant-name";

// ChartAiOverlayPanel — the legend / control surface for ARX Native Chart
// Level 5 AI overlays. PURE VISUALISATION + an on-demand read trigger: it never
// places, modifies, or closes a trade.
//
// HONESTY: every figure shown here is a REAL output —
//   - the scanner signal carries its own confidence, status badge, and honest
//     `dataSource` tag (SIMULATOR / LIVE_FEED / …) so a simulated read is never
//     presented as a live one;
//   - the Ruby read is the read-only assistant's structured output, surfaced
//     only when it has enough data;
//   - when the chart feed is not AI-confirmed (Level 3), overlays are suppressed
//     and we say so plainly instead of drawing a stale read.

function pct(conf: number): string {
  return `${Math.round(Math.max(0, Math.min(1, conf)) * 100)}%`;
}

function badgeLabel(badge: string): string {
  return badge.replace(/_/g, " ").toLowerCase();
}

function biasTone(bias: string): string {
  const b = (bias || "").toLowerCase();
  if (b.includes("bull")) return "text-success";
  if (b.includes("bear")) return "text-danger";
  return "text-txt-secondary";
}

export function ChartAiOverlayPanel({
  data,
}: {
  data: UseAiChartOverlaysResult;
}) {
  const { name } = useAssistantName();
  const { signal, ruby, suppressed, suppressedReason, requestRubyRead } = data;

  return (
    <div
      className="rounded-md border border-premium/20 bg-premium/10 p-3 text-[11px] leading-snug"
      data-testid="chart-ai-overlay-panel"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-premium" />
        <span className="font-semibold text-premium">AI overlays</span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-6 px-2 text-[10px]"
          disabled={suppressed || ruby.status === "loading"}
          onClick={() => requestRubyRead()}
          data-testid="chart-ai-overlay-ruby-read"
        >
          {ruby.status === "loading" ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : null}
          {ruby.read ? `Re-read with ${name}` : `Read with ${name}`}
        </Button>
      </div>

      {suppressed ? (
        <div
          className="mt-2 flex items-start gap-1.5 text-warning/90"
          data-testid="chart-ai-overlay-suppressed"
        >
          <ShieldOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{suppressedReason}</span>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          {/* Scanner signal legend (real, attributed). */}
          {signal ? (
            <div className="space-y-1" data-testid="chart-ai-overlay-signal">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <Radar className="h-3.5 w-3.5 text-ruby" />
                <span className="text-txt-muted">Scanner:</span>
                <span
                  className={`font-semibold ${
                    signal.side === "BUY" ? "text-success" : "text-danger"
                  }`}
                >
                  {signal.side}
                </span>
                <span className="text-txt-muted">conf</span>
                <span className="font-semibold text-foreground">{pct(signal.confidence)}</span>
                {signal.statusBadge && (
                  <span className="rounded bg-muted/80 px-1.5 py-0.5 text-[10px] text-txt-secondary">
                    {badgeLabel(signal.statusBadge)}
                  </span>
                )}
                <span
                  className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                  title="Honest data source for this signal"
                  data-testid="chart-ai-overlay-datasource"
                >
                  {signal.dataSource || "UNKNOWN"}
                </span>
                {signal.timeframe && (
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] ${
                      signal.timeframeMatchesChart
                        ? "border-border text-muted-foreground"
                        : "border-warning/25 text-warning/90"
                    }`}
                    title={
                      signal.timeframeMatchesChart
                        ? "Signal timeframe matches the chart"
                        : "Signal is from a different timeframe than the chart"
                    }
                    data-testid="chart-ai-overlay-timeframe"
                  >
                    {signal.timeframe}
                    {signal.timeframeMatchesChart ? "" : " ≠ chart"}
                  </span>
                )}
              </div>
              {signal.finalReadHeadline && (
                <div className="text-muted-foreground">{signal.finalReadHeadline}</div>
              )}
            </div>
          ) : (
            <div className="text-txt-muted" data-testid="chart-ai-overlay-no-signal">
              No scanner signal for this symbol right now.
            </div>
          )}

          {/* Ruby read summary (on-demand). */}
          {ruby.status === "error" && (
            <div className="text-danger" data-testid="chart-ai-overlay-ruby-err">
              {name} couldn't read this chart ({ruby.error}).
            </div>
          )}
          {ruby.status === "insufficient" && (
            <div className="text-warning/90" data-testid="chart-ai-overlay-ruby-insufficient">
              {name} read: not enough confirmed data to mark zones.
            </div>
          )}
          {ruby.status === "ok" && ruby.read && (
            <div className="space-y-0.5 text-txt-secondary" data-testid="chart-ai-overlay-ruby-body">
              <div className="flex flex-wrap items-center gap-x-2">
                <Sparkles className="h-3.5 w-3.5 text-premium" />
                <span className="text-txt-muted">{name}:</span>
                <span className={`font-semibold ${biasTone(ruby.read.bias)}`}>{ruby.read.bias}</span>
                <span className="text-txt-muted">·</span>
                <span className="text-muted-foreground">{ruby.read.confidence}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 text-muted-foreground">
                <div><span className="text-txt-muted">Support:</span> {ruby.read.supportZone}</div>
                <div><span className="text-txt-muted">Resistance:</span> {ruby.read.resistanceZone}</div>
              </div>
              {ruby.read.goldStrategyRead?.active && (
                <div
                  className="mt-1 border-t border-warning/25 pt-1 text-warning/90"
                  data-testid="chart-ai-overlay-gold"
                >
                  <span className="font-semibold text-warning">Gold mode</span>
                  <span className="text-txt-muted"> · macro </span>
                  {ruby.read.goldStrategyRead.macroBias}
                  <span className="text-txt-muted"> · ATR </span>
                  {ruby.read.goldStrategyRead.atrState}
                  <div className="text-warning/70">{ruby.read.goldStrategyRead.riskWarning}</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ChartAiOverlayPanel;
