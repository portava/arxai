// Phase UX8 — Unified Trade Action Review Modal.
//
// SAFETY:
//   * ARX never confirms on the user's behalf. The Confirm button is
//     enabled ONLY after the user clicks Review and (for LIVE) types the
//     CONFIRM phrase verbatim.
//   * On Cancel we POST :id/cancel — no silent drops.
//   * No secrets, no master credentials, no auto-close, no guard bypass.

import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Loader2, ShieldCheck, X } from "lucide-react";

export type ActionType = "OPEN" | "CLOSE" | "PARTIAL_CLOSE" | "MOVE_STOP" | "TRAIL_STOP" | "MODIFY_TP_SL" | "CANCEL_ORDER";
export type ActionMode = "SIMULATED" | "DEMO" | "LIVE";

export interface TradeActionSummary {
  id: number;
  actionType: ActionType;
  status: string;
  tradeKey: string | null;
  symbol: string | null;
  side: "BUY" | "SELL" | null;
  lotSize: number | null;
  requestedMode: ActionMode;
  requestedPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  reason: string | null;
  rejectionReason: string | null;
  expiresAt: string | null;
  createdAt: string;
  // Phase UX9 — execution result surface.
  mt5OrderTicket?: string | null;
  mt5PositionTicket?: string | null;
  fillPrice?: number | null;
  slippage?: number | null;
  filledLotSize?: number | null;
  brokerMessage?: string | null;
  errorCode?: string | null;
  executedAt?: string | null;
  staleAt?: string | null;
  guardChecks?: Array<{ id: string; name: string; passed: boolean; detail?: string | null }>;
}

interface Props {
  open: boolean;
  action: TradeActionSummary | null;
  onClose: () => void;
  onConfirmed?: (next: TradeActionSummary) => void;
  onCancelled?: (next: TradeActionSummary) => void;
}

const LIVE_PHRASE = "CONFIRM LIVE";

export function TradeActionReviewModal({ open, action, onClose, onConfirmed, onCancelled }: Props) {
  const [step, setStep] = useState<"summary" | "confirm">("summary");
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardFail, setGuardFail] = useState<TradeActionSummary["guardChecks"]>([]);

  useEffect(() => {
    if (!open) { setStep("summary"); setConfirmText(""); setError(null); setGuardFail([]); setSubmitting(false); }
  }, [open]);

  const isLive = action?.requestedMode === "LIVE";
  const liveOk = !isLive || confirmText.trim().toUpperCase() === LIVE_PHRASE;
  const isTerminal = action ? ["executed","rejected","failed","expired","cancelled"].includes(action.status) : true;

  const title = useMemo(() => {
    if (!action) return "Trade action";
    const t = action.actionType.replaceAll("_", " ").toLowerCase();
    return `Review ${t}${action.symbol ? ` — ${action.symbol}` : ""}`;
  }, [action]);

  async function doConfirm() {
    if (!action) return;
    setSubmitting(true); setError(null); setGuardFail([]);
    try {
      const r = await fetch(`/api/me/trade-actions/${action.id}/confirm`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isLive ? { liveConfirmPhrase: confirmText.trim().toUpperCase() } : {}),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        setError(data.error ?? `HTTP ${r.status}`);
        if (data.action?.guardChecks) setGuardFail(data.action.guardChecks.filter((c: { passed: boolean }) => !c.passed));
        return;
      }
      onConfirmed?.(data.action);
      onClose();
    } catch (e) {
      setError((e as Error).message ?? "confirm_failed");
    } finally { setSubmitting(false); }
  }

  async function doCancel() {
    if (!action) return;
    setSubmitting(true); setError(null);
    try {
      const r = await fetch(`/api/me/trade-actions/${action.id}/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "user_cancelled_in_modal" }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) { setError(data.error ?? `HTTP ${r.status}`); return; }
      onCancelled?.(data.action);
      onClose();
    } catch (e) {
      setError((e as Error).message ?? "cancel_failed");
    } finally { setSubmitting(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg w-[95vw] max-h-[90vh] overflow-y-auto" data-testid="modal-trade-action-review">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            {title}
          </DialogTitle>
          <DialogDescription>
            ARX never executes automatically. Every action requires your explicit confirmation.
          </DialogDescription>
        </DialogHeader>

        {!action ? (
          <div className="p-4 text-sm text-muted-foreground">No action selected.</div>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" data-testid="badge-action-type">{action.actionType}</Badge>
              <Badge variant={action.requestedMode === "LIVE" ? "destructive" : "secondary"} data-testid="badge-action-mode">
                {action.requestedMode}
              </Badge>
              <Badge variant="outline" data-testid="badge-action-status">{action.status}</Badge>
              {action.tradeKey && <span className="text-xs text-muted-foreground">#{action.tradeKey}</span>}
            </div>

            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-md border p-3 bg-muted/30">
              {action.symbol && (<><dt className="text-muted-foreground">Symbol</dt><dd>{action.symbol}</dd></>)}
              {action.side && (<><dt className="text-muted-foreground">Side</dt><dd>{action.side}</dd></>)}
              {action.lotSize != null && (<><dt className="text-muted-foreground">Lot</dt><dd>{action.lotSize}</dd></>)}
              {action.requestedPrice != null && (<><dt className="text-muted-foreground">Price</dt><dd>{action.requestedPrice}</dd></>)}
              {action.stopLoss != null && (<><dt className="text-muted-foreground">Stop loss</dt><dd>{action.stopLoss}</dd></>)}
              {action.takeProfit != null && (<><dt className="text-muted-foreground">Take profit</dt><dd>{action.takeProfit}</dd></>)}
              {action.expiresAt && (<><dt className="text-muted-foreground">Expires</dt><dd>{new Date(action.expiresAt).toLocaleString()}</dd></>)}
            </dl>

            {action.reason && (
              <div className="rounded-md border p-3 text-xs">
                <div className="text-muted-foreground mb-1">Reason</div>
                <div data-testid="text-action-reason">{action.reason}</div>
              </div>
            )}

            {isLive && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs space-y-1">
                <div className="flex items-center gap-1.5 font-medium text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" /> LIVE mode disclosure
                </div>
                <p>This will queue a REAL order through the bridge. Real money is at risk. Decision support only — not guaranteed.</p>
              </div>
            )}

            {(action.mt5OrderTicket || action.mt5PositionTicket || action.fillPrice != null || action.executedAt) && (
              <div className="rounded-md border p-3 text-xs space-y-1" data-testid="block-execution-result">
                <div className="font-medium flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5 text-primary" /> Broker execution result
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                  {action.mt5OrderTicket && (<><dt className="text-muted-foreground">Order ticket</dt><dd data-testid="text-mt5-order-ticket">{action.mt5OrderTicket}</dd></>)}
                  {action.mt5PositionTicket && (<><dt className="text-muted-foreground">Position ticket</dt><dd data-testid="text-mt5-position-ticket">{action.mt5PositionTicket}</dd></>)}
                  {action.requestedPrice != null && (<><dt className="text-muted-foreground">Requested</dt><dd>{action.requestedPrice}</dd></>)}
                  {action.fillPrice != null && (<><dt className="text-muted-foreground">Fill price</dt><dd data-testid="text-fill-price">{action.fillPrice}</dd></>)}
                  {action.slippage != null && (<><dt className="text-muted-foreground">Slippage</dt><dd data-testid="text-slippage">{action.slippage}</dd></>)}
                  {action.filledLotSize != null && (<><dt className="text-muted-foreground">Filled lot</dt><dd>{action.filledLotSize}</dd></>)}
                  {action.executedAt && (<><dt className="text-muted-foreground">Executed at</dt><dd>{new Date(action.executedAt).toLocaleString()}</dd></>)}
                </dl>
              </div>
            )}

            {action.rejectionReason && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs space-y-1" data-testid="text-rejection-reason">
                <div className="font-medium text-destructive flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {action.errorCode === "WATCHDOG_STALE"
                    ? "Action timed out"
                    : action.status === "rejected"
                      ? "Rejected by broker"
                      : "Action failed"}
                  {action.errorCode && (
                    <Badge variant="outline" className="text-[10px] ml-1">{action.errorCode}</Badge>
                  )}
                </div>
                <div className="text-destructive">{action.rejectionReason}</div>
                {action.brokerMessage && action.brokerMessage !== action.rejectionReason && (
                  <div className="text-muted-foreground" data-testid="text-broker-message">Broker: {action.brokerMessage}</div>
                )}
              </div>
            )}

            {guardFail && guardFail.length > 0 && (
              <div className="rounded-md border p-3 text-xs space-y-1" data-testid="list-guard-fails">
                <div className="font-medium">Guard failures</div>
                {guardFail.map((c) => (
                  <div key={c.id} className="flex justify-between gap-2">
                    <span>{c.name}</span>
                    <span className="text-muted-foreground">{c.detail ?? "blocked"}</span>
                  </div>
                ))}
              </div>
            )}

            {!isTerminal && step === "confirm" && isLive && (
              <div>
                <label className="text-xs text-muted-foreground">Type <code className="font-mono">{LIVE_PHRASE}</code> to enable confirmation</label>
                <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)}
                  className="mt-1" data-testid="input-live-confirm" autoFocus />
              </div>
            )}

            {error && <div className="text-xs text-destructive" data-testid="text-action-error">Error: {error}</div>}
          </div>
        )}

        <DialogFooter className="flex flex-col-reverse sm:flex-row gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting} data-testid="button-close-modal">
            <X className="h-4 w-4 mr-1" /> Close
          </Button>
          {action && !isTerminal && (
            <Button variant="outline" onClick={doCancel} disabled={submitting} data-testid="button-cancel-action">
              {submitting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              Cancel action
            </Button>
          )}
          {action && !isTerminal && step === "summary" && (
            <Button onClick={() => setStep("confirm")} data-testid="button-review-confirm">
              Review &amp; confirm
            </Button>
          )}
          {action && !isTerminal && step === "confirm" && (
            <Button onClick={doConfirm} disabled={submitting || !liveOk}
              variant={isLive ? "destructive" : "default"} data-testid="button-confirm-action">
              {submitting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <ShieldCheck className="h-4 w-4 mr-1" />}
              {isLive ? "Confirm LIVE action" : "Confirm action"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default TradeActionReviewModal;
