import React from "react";
import { useCreateExecutionConfirmation, useConfirmExecution, useCancelExecution } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ShieldCheck, ShieldAlert, ShieldX, AlertTriangle, X, CheckCircle2 } from "lucide-react";
import { ConfirmExecutionButton } from "./ConfirmExecutionButton";
import { CancelTradeButton } from "./CancelTradeButton";
import { ExecutionWarningPanel } from "./ExecutionWarningPanel";

/**
 * Pre-Trade Checklist Modal — Build F primary user-facing safety surface.
 *
 * Two-phase flow:
 *   1. `intent` provided → POST /execution-confirmations (server runs the
 *      checklist, returns verdict + warnings + blockers + risk summary).
 *   2. User reviews the read-only checklist and clicks Confirm or Cancel.
 *
 * The Confirm button is hard-disabled while the verdict is BLOCKED. WARN
 * verdicts require explicit user click — never auto-confirms.
 */
export interface PreTradeIntent {
  symbol: string;
  direction: "BUY" | "SELL";
  lotSize: number;
  entryType?: "MARKET" | "LIMIT" | "STOP";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  marketCondition?: "TRENDING" | "RANGING" | "NO_TRADE" | "UNKNOWN";
  spreadPips?: number | null;
  practiceMode?: boolean;
  aiConfidence?: number | null;
  fitScore?: number | null;
}

interface Props {
  open: boolean;
  intent: PreTradeIntent | null;
  onClose: () => void;
  onConfirmed?: (confirmationId: number) => void;
}

export function PreTradeChecklistModal({ open, intent, onClose, onConfirmed }: Props) {
  const create = useCreateExecutionConfirmation();
  const confirmMut = useConfirmExecution();
  const cancelMut = useCancelExecution();
  const [confirmation, setConfirmation] = React.useState<Awaited<ReturnType<typeof create.mutateAsync>> | null>(null);

  React.useEffect(() => {
    if (!open || !intent) {
      setConfirmation(null);
      return;
    }
    create.mutateAsync({ data: intent })
      .then((r) => setConfirmation(r))
      .catch(() => { /* error surfaced via create.error */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, intent?.symbol, intent?.direction, intent?.lotSize, intent?.entryPrice, intent?.stopLoss, intent?.takeProfit]);

  const verdict = (confirmation as { verdict?: "APPROVED" | "WARN" | "BLOCKED" } | null)?.verdict ?? "BLOCKED";
  const blockers: string[] = ((confirmation as { blockers?: string[] } | null)?.blockers) ?? [];
  const warnings: string[] = ((confirmation as { warnings?: string[] } | null)?.warnings) ?? [];

  const verdictMeta = {
    APPROVED: { label: "Approved", icon: ShieldCheck, tone: "text-success", bg: "bg-success/10 border-success/30" },
    WARN:     { label: "Caution",  icon: ShieldAlert, tone: "text-warning", bg: "bg-warning/10 border-warning/30" },
    BLOCKED:  { label: "Blocked",  icon: ShieldX,    tone: "text-danger",   bg: "bg-danger/10 border-danger/30" },
  }[verdict];
  const VerdictIcon = verdictMeta.icon;

  async function handleConfirm() {
    if (!confirmation) return;
    const updated = await confirmMut.mutateAsync({ id: confirmation.id, data: {} });
    onConfirmed?.(updated.id);
    onClose();
  }

  async function handleCancel() {
    if (confirmation && (confirmation.status === "PENDING" || confirmation.status === "CONFIRMED")) {
      await cancelMut.mutateAsync({ id: confirmation.id, data: { reason: "User cancelled" } }).catch(() => { /* swallow — closing anyway */ });
    }
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleCancel(); }}>
      <DialogContent className="max-w-lg" data-testid="pretrade-checklist-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <VerdictIcon size={18} className={verdictMeta.tone} />
            Pre-Trade Checklist
          </DialogTitle>
          <DialogDescription>
            Review every safety check before this order is sent.
          </DialogDescription>
        </DialogHeader>

        {create.isPending && <div className="py-6 text-center text-sm text-muted-foreground">Running checklist…</div>}
        {create.isError && <div className="py-4 text-sm text-danger">Failed to run checklist. Please try again.</div>}

        {confirmation && intent && (
          <div className="space-y-3">
            <div className={`rounded-md border p-3 ${verdictMeta.bg}`}>
              <div className={`text-xs font-bold uppercase tracking-wider ${verdictMeta.tone}`}>{verdictMeta.label}</div>
              <div className="text-sm mt-1">
                {verdict === "APPROVED" && "All safety checks passed. Click Confirm to proceed."}
                {verdict === "WARN" && "Trade may proceed, but please review the warnings below."}
                {verdict === "BLOCKED" && "This order cannot be sent — see the blockers below."}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <Row label="Symbol" value={intent.symbol} mono />
              <Row label="Direction" value={intent.direction} />
              <Row label="Entry Type" value={intent.entryType ?? "MARKET"} />
              <Row label="Lot Size" value={intent.lotSize.toString()} />
              <Row label="Entry Price" value={intent.entryPrice.toFixed(5)} mono />
              <Row label="Stop Loss" value={intent.stopLoss.toFixed(5)} mono />
              <Row label="Take Profit" value={intent.takeProfit.toFixed(5)} mono />
              <Row label="Estimated Risk" value={`$${confirmation.estimatedRisk.toFixed(2)}`} />
              <Row label="Reward : Risk" value={`${confirmation.rewardToRisk.toFixed(2)} : 1`} />
              <Row label="Market" value={confirmation.marketCondition} />
              <Row label="Permission" value={confirmation.permissionStatus} />
              <Row label="Broker" value={confirmation.brokerConnected ? "Connected" : "Disconnected"} />
              {typeof confirmation.aiConfidence === "number" && <Row label="AI Confidence" value={`${confirmation.aiConfidence.toFixed(0)}%`} />}
              {typeof confirmation.fitScore === "number" && <Row label="Fit Score" value={confirmation.fitScore.toFixed(0)} />}
            </div>

            <ExecutionWarningPanel warnings={warnings} blockers={blockers} />
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <CancelTradeButton onClick={handleCancel} disabled={cancelMut.isPending} />
          <ConfirmExecutionButton
            onClick={handleConfirm}
            disabled={!confirmation || verdict === "BLOCKED" || confirmMut.isPending}
            verdict={verdict}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2 px-2 py-1.5 rounded bg-muted/30">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

void X; void CheckCircle2; void AlertTriangle;
