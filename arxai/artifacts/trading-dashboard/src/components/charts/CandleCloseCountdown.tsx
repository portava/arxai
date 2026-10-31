import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatCandleCountdown } from "@/components/scanner/scannerChartFormat";
export function CandleCloseCountdown({
  closeTimeMs,
  timeframe,
}: {
  closeTimeMs: number;
  timeframe: string;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const remainingMs = closeTimeMs - nowMs;
  // Bar already closed; the next forming frame supplies the new close time.
  if (remainingMs <= 0) return null;
  return (
    <Badge
      variant="outline"
      className="gap-1 font-mono text-[10px] border-emerald-500/30 text-emerald-300"
      data-testid="scanner-chart-countdown"
      title="Time until the current candle closes"
    >
      <Clock className="h-2.5 w-2.5" />
      {formatCandleCountdown(remainingMs, timeframe)}
    </Badge>
  );
}
