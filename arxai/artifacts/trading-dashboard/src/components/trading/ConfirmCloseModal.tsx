import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { OpenCard } from "./MyOpenTradesPanel";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const u = (p: string) => `${BASE}${p}`;

export function ConfirmCloseModal({
  card, accountType, tradingMode, onClose, onClosed,
}: {
  card: OpenCard;
  accountType: "demo" | "live" | "unknown";
  tradingMode: "DISABLED" | "DEMO" | "LIVE" | "SIMULATED";
  onClose: () => void;
  onClosed: () => void;
}) {
  const isLive = accountType === "live" || tradingMode === "LIVE";
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(u("/api/me/trades/close"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cardId: card.id, confirmedByUser: true }),
      });
      const body = await r.json();
      if (!r.ok || !body.ok) {
        setErr(String(body.error ?? `HTTP ${r.status}`));
        return;
      }
      onClosed();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isLive && <AlertTriangle className="h-5 w-5 text-danger" />}
            Close {card.symbol} {card.side}?
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <div className="rounded border border-border p-3">
            <div>Symbol: <span className="text-foreground">{card.symbol}</span></div>
            <div>Side: <span className="text-foreground">{card.side}</span></div>
            <div>Size: <span className="text-foreground">{card.lotSize} lots</span></div>
            <div>Entry: <span className="text-foreground">{card.entryPrice ?? "—"}</span></div>
            <div>
              P&L:{" "}
              <span className={(card.unrealizedPnl ?? 0) >= 0 ? "text-success" : "text-danger"}>
                {card.waitingForSync ? "waiting for sync" : (card.unrealizedPnl ?? 0).toFixed(2)}
              </span>
            </div>
          </div>
          {isLive && (
            <div className="rounded bg-danger/10 p-3 text-danger">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4" />
                <div>
                  This is a <strong>LIVE</strong> account. Closing will send a real
                  market-close order to your broker.
                </div>
              </div>
              <label className="mt-2 flex items-start gap-2">
                <Checkbox
                  checked={ack}
                  onCheckedChange={(v) => setAck(v === true)}
                  data-testid="live-close-ack"
                />
                <span className="text-xs">
                  I understand this closes a real-money position.
                </span>
              </label>
            </div>
          )}
          {err && (
            <div className="rounded bg-danger/10 p-2 text-xs text-danger">{err}</div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={busy || (isLive && !ack)}
            data-testid="confirm-close-btn"
          >
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Confirm Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
