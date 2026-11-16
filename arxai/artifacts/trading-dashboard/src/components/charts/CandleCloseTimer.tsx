import { useEffect, useState } from "react";
import { Clock3 } from "lucide-react";
import {
  candleCountdown,
  countdownText,
} from "@/lib/chart-engine/candleCountdown";
export function CandleCloseTimer({
  timeframe,
  barOpen,
  live,
  closed,
}: {
  timeframe: string;
  barOpen: number | null;
  live: boolean;
  closed: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const timer = candleCountdown(timeframe, now, live ? barOpen : null);
  const scheduled = !live || timer?.scheduled;
  return (
    <div
      data-testid="candle-close-timer"
      className="ml-2 inline-flex min-h-7 items-center gap-1.5 rounded border border-cyan-500/25 bg-cyan-500/5 px-2 text-[11px] text-cyan-200"
      title={
        closed
          ? "The market is closed; countdown is paused."
          : scheduled
            ? "Scheduled UTC interval boundary. The price feed is not confirmed current."
            : "Time remaining in the current received candle. This clock does not indicate trade readiness."
      }
    >
      <Clock3 className="h-3.5 w-3.5" />
      <span>
        {closed
          ? "Market closed"
          : scheduled
            ? "Interval closes"
            : "Candle closes"}
      </span>
      <span role="timer" aria-live="off" className="font-mono tabular-nums">
        {closed ? "Paused" : timer ? countdownText(timer.remaining) : "—:—"}
      </span>
      {!closed && scheduled && (
        <span className="text-muted-foreground">clock only</span>
      )}
    </div>
  );
}
