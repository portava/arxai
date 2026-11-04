import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  candleCountdownLabel,
  computeCandleRemainingMs,
  type ServerClockSample,
} from "@/components/scanner/scannerChartFormat";
export function CandleCloseCountdown({
  closeTimeMs,
  timeframe,
  clockRef,
}: {
  closeTimeMs: number;
  timeframe: string;
  /** Server clock + bar interval from the latest accepted tick-stream frame. */
  clockRef?: { current: (ServerClockSample & { intervalMs: number | null }) | null };
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  // Measured against the SERVER clock (frame ts + monotonic elapsed), so a
  // client clock that runs fast/slow cannot shrink, inflate or hide it.
  // Without a server sample it falls back to the client clock.
  const clock = clockRef?.current ?? null;
  const remainingMs = computeCandleRemainingMs({
    closeTimeMs,
    clock,
    nowPerf: performance.now(),
    fallbackNowMs: Date.now(),
  });
  // Bar already closed; the next forming frame supplies the new close time.
  if (remainingMs <= 0) return null;
  // More time left than one bar lasts is impossible without skew — hide
  // rather than show an inflated number.
  if (clock?.intervalMs != null && remainingMs > clock.intervalMs) return null;
  return (
    <Badge
      variant="outline"
      className="gap-1 font-mono text-[10px] border-emerald-500/30 text-emerald-300"
      data-testid="scanner-chart-countdown"
      title="Time until the current candle closes"
    >
      <Clock className="h-2.5 w-2.5" />
      {candleCountdownLabel(remainingMs, timeframe)}
    </Badge>
  );
}
