// Ruby execution (2026-11-04): the chat panel's view of what Ruby is watching.
// Shows active conditional entries/closes and position monitors, and — when a
// monitor has alerted on reversal evidence — the "Keep it" / "Close it" answer
// buttons. Polls while mounted; read-only except for the two answer buttons,
// which call the gated ack route (the server re-checks authority at fire time).
import { useCallback, useEffect, useState } from "react";
import { Eye, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ackRubyWatch, fetchRubyWatches, type RubyWatchView } from "@/lib/instantTradeRouter";

const POLL_MS = 15_000;

export function describeWatch(w: RubyWatchView): string {
  if (w.kind === "MONITOR_TRADE") return `Monitoring ${w.symbol ?? "position"}${w.positionTicket ? ` #${w.positionTicket}` : ""}`;
  if (w.kind === "WATCH_AND_ENTER") return `${w.side === "SELL" ? "Sell" : "Buy"} ${w.symbol ?? ""}${w.lot ? ` ${w.lot}` : ""} when price ${w.trigger?.op === "<=" ? "drops to" : "reaches"} ${w.trigger?.price ?? "?"}`;
  if (w.kind === "WATCH_AND_CLOSE") return `Close ${w.symbol ?? ""} when price ${w.trigger?.op === "<=" ? "drops to" : "reaches"} ${w.trigger?.price ?? "?"}`;
  return `${w.kind} ${w.symbol ?? ""}`.trim();
}

export function RubyWatchesStrip({ onMessage, refreshKey = 0 }: { onMessage?: (text: string) => void; refreshKey?: number }) {
  const [watches, setWatches] = useState<RubyWatchView[] | null>(null);
  const [sweeperRunning, setSweeperRunning] = useState<boolean | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const r = await fetchRubyWatches();
    if (r.ok) {
      setWatches(r.watches);
      setSweeperRunning(r.sweeper ? r.sweeper.running : null);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load, refreshKey]);

  if (!watches || watches.length === 0) return null;

  async function answer(w: RubyWatchView, decision: "keep" | "close") {
    setBusyId(w.id);
    try {
      const r = await ackRubyWatch(w.id, decision);
      onMessage?.(r.message ?? (r.ok ? "Done." : `Couldn't record that: ${r.error ?? "unknown error"}.`));
      await load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-4 mt-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs space-y-1.5" data-testid="ruby-watches-strip">
      <div className="flex items-center gap-1.5 font-semibold text-foreground">
        <Eye className="h-3.5 w-3.5 text-ruby" />
        Ruby is watching {watches.length} {watches.length === 1 ? "thing" : "things"}
        {sweeperRunning === false && (
          <span className="ml-auto inline-flex items-center gap-1 text-danger" data-testid="ruby-watches-sweeper-off">
            <ShieldAlert className="h-3.5 w-3.5" /> sweeper off — not being evaluated
          </span>
        )}
      </div>
      <ul className="space-y-1">
        {watches.map((w) => {
          const awaiting = w.monitor?.awaitingAnswer === true;
          return (
            <li key={w.id} className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid={`ruby-watch-${w.id}`}>
              <span className="text-txt-secondary">{describeWatch(w)}</span>
              {w.monitor && w.monitor.alertsSinceAck > 0 && (
                <span className={awaiting ? "font-semibold text-danger" : "text-txt-muted"} data-testid={`ruby-watch-${w.id}-alerts`}>
                  reversal alert {w.monitor.alertsSinceAck}/{w.monitor.maxAlerts}
                  {w.monitor.alertsSinceAck >= w.monitor.maxAlerts ? " — closing soon unless you answer" : ""}
                </span>
              )}
              {awaiting && (
                <span className="inline-flex gap-1">
                  <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={busyId === w.id}
                    onClick={() => void answer(w, "keep")} data-testid={`ruby-watch-${w.id}-keep`}>
                    {busyId === w.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Keep it"}
                  </Button>
                  <Button size="sm" variant="destructive" className="h-6 px-2 text-[11px]" disabled={busyId === w.id}
                    onClick={() => void answer(w, "close")} data-testid={`ruby-watch-${w.id}-close`}>
                    Close it
                  </Button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
