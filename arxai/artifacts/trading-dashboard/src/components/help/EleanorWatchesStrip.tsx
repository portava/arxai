// Eleanor execution (2026-11-04): the chat panel's view of what Eleanor is watching.
// Shows active conditional entries/closes and position monitors, and — when a
// monitor has alerted on reversal evidence — the "Keep it" / "Close it" answer
// buttons. Polls while mounted; read-only except for the two answer buttons,
// which call the gated ack route (the server re-checks authority at fire time).
import { useCallback, useEffect, useState } from "react";
import { Eye, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAssistantName } from "@/lib/assistant-name";
import { ackEleanorWatch, fetchEleanorWatches, setEleanorWatchFakeoutAuthority, type EleanorWatchView } from "@/lib/instantTradeRouter";

const POLL_MS = 15_000;

export function describeWatch(w: EleanorWatchView): string {
  if (w.kind === "MONITOR_TRADE") return `Monitoring ${w.symbol ?? "position"}${w.positionTicket ? ` #${w.positionTicket}` : ""}`;
  if (w.kind === "WATCH_AND_ENTER") return `${w.side === "SELL" ? "Sell" : "Buy"} ${w.symbol ?? ""}${w.lot ? ` ${w.lot}` : ""} when price ${w.trigger?.op === "<=" ? "drops to" : "reaches"} ${w.trigger?.price ?? "?"}`;
  if (w.kind === "WATCH_AND_CLOSE") return `Close ${w.symbol ?? ""} when price ${w.trigger?.op === "<=" ? "drops to" : "reaches"} ${w.trigger?.price ?? "?"}`;
  return `${w.kind} ${w.symbol ?? ""}`.trim();
}

/** One line for the last fakeout shift Eleanor sent (or was refused). */
export function describeFakeoutShift(a: { at: string; toStopLoss: number | null; toTakeProfit: number | null; ok: boolean; blocked: string | null }): string {
  const what = a.toStopLoss != null ? `stop → ${a.toStopLoss}` : a.toTakeProfit != null ? `target → ${a.toTakeProfit}` : "levels";
  const t = Number.isFinite(Date.parse(a.at)) ? new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  return a.ok
    ? `Last fakeout shift: ${what}${t ? ` at ${t}` : ""} (sent; broker confirms)`
    : `Fakeout shift refused: ${what}${a.blocked ? ` (${a.blocked})` : ""}`;
}

export function EleanorWatchesStrip({ onMessage, refreshKey = 0 }: { onMessage?: (text: string) => void; refreshKey?: number }) {
  const { name: assistantName } = useAssistantName();
  const [watches, setWatches] = useState<EleanorWatchView[] | null>(null);
  const [sweeperRunning, setSweeperRunning] = useState<boolean | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const r = await fetchEleanorWatches();
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

  // Per-monitor authority (owner spec 2026-11-04): let Eleanor shift the stop or
  // target on a fakeout — bounded (≤50% of the original risk, TP only tightened,
  // 2 shifts per monitor) and audited; the broker confirms every change.
  async function toggleFakeout(w: EleanorWatchView, enabled: boolean) {
    setBusyId(w.id);
    try {
      const r = await setEleanorWatchFakeoutAuthority(w.id, enabled);
      onMessage?.(r.message ?? (r.ok ? (enabled ? "Fakeout authority granted for this position." : "Fakeout authority removed.") : `Couldn't change that: ${r.error ?? "unknown error"}.`));
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function answer(w: EleanorWatchView, decision: "keep" | "close") {
    setBusyId(w.id);
    try {
      const r = await ackEleanorWatch(w.id, decision);
      onMessage?.(r.message ?? (r.ok ? "Done." : `Couldn't record that: ${r.error ?? "unknown error"}.`));
      await load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-4 mt-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs space-y-1.5" data-testid="eleanor-watches-strip">
      <div className="flex items-center gap-1.5 font-semibold text-foreground">
        <Eye className="h-3.5 w-3.5 text-eleanor" />
        {assistantName} is watching {watches.length} {watches.length === 1 ? "thing" : "things"}
        {sweeperRunning === false && (
          <span className="ml-auto inline-flex items-center gap-1 text-danger" data-testid="eleanor-watches-sweeper-off">
            <ShieldAlert className="h-3.5 w-3.5" /> sweeper off — not being evaluated
          </span>
        )}
      </div>
      <ul className="space-y-1">
        {watches.map((w) => {
          const awaiting = w.monitor?.awaitingAnswer === true;
          return (
            <li key={w.id} className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid={`eleanor-watch-${w.id}`}>
              <span className="text-txt-secondary">{describeWatch(w)}</span>
              {w.monitor && w.monitor.alertsSinceAck > 0 && (
                <span className={awaiting ? "font-semibold text-danger" : "text-txt-muted"} data-testid={`eleanor-watch-${w.id}-alerts`}>
                  reversal alert {w.monitor.alertsSinceAck}/{w.monitor.maxAlerts}
                  {w.monitor.alertsSinceAck >= w.monitor.maxAlerts ? " — closing soon unless you answer" : ""}
                </span>
              )}
              {w.kind === "MONITOR_TRADE" && w.monitor && (
                <label className="inline-flex items-center gap-1 text-[11px] text-txt-secondary" title="Bounded: stop moved at most 50% of your original risk beyond the fakeout wick, target only tightened, two shifts per position. Every shift is announced and audited.">
                  <Switch
                    checked={w.monitor.fakeoutAuthority === true}
                    disabled={busyId === w.id}
                    onCheckedChange={(v) => void toggleFakeout(w, v)}
                    aria-label={`Let ${assistantName} shift SL/TP on a fakeout`}
                    className="scale-75"
                    data-testid={`eleanor-watch-${w.id}-fakeout`}
                  />
                  Shift SL/TP on fakeout
                  {(w.monitor.fakeoutAdjustments ?? 0) > 0 && <span data-testid={`eleanor-watch-${w.id}-fakeout-count`}>· {w.monitor.fakeoutAdjustments} shift{w.monitor.fakeoutAdjustments === 1 ? "" : "s"}</span>}
                </label>
              )}
              {w.kind === "MONITOR_TRADE" && w.monitor?.lastFakeoutAdjustment && (
                <span
                  className={w.monitor.lastFakeoutAdjustment.ok ? "text-[11px] text-txt-muted" : "text-[11px] text-danger"}
                  title={w.monitor.lastFakeoutAdjustment.reason}
                  data-testid={`eleanor-watch-${w.id}-fakeout-last`}
                >
                  {describeFakeoutShift(w.monitor.lastFakeoutAdjustment)}
                </span>
              )}
              {awaiting && (
                <span className="inline-flex gap-1">
                  <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={busyId === w.id}
                    onClick={() => void answer(w, "keep")} data-testid={`eleanor-watch-${w.id}-keep`}>
                    {busyId === w.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Keep it"}
                  </Button>
                  <Button size="sm" variant="destructive" className="h-6 px-2 text-[11px]" disabled={busyId === w.id}
                    onClick={() => void answer(w, "close")} data-testid={`eleanor-watch-${w.id}-close`}>
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
