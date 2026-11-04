// ModifySlTpDialog — MT5 "Modify or Delete Order" for an OPEN position: set or
// change Stop Loss / Take Profit. Side rule as in MT5 (Buy: SL below, TP above
// the current price; Sell: the reverse). Live → instant-trade router
// MODIFY_SL_TP; demo → governed queue MODIFY_SLTP. The broker confirms; the
// server re-checks the sides and its own freeze/stop levels.
//
// An empty field leaves that level as it is on both scopes (demo sends the
// position's current level, because the demo EA applies exactly what it gets).
// "Remove" clears a level; only the demo terminal can express that — the live
// EA reads 0 as "leave as is", so removal is disabled on live.
import { useEffect, useState } from "react";
import { Loader2, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { humanizeReason } from "@/lib/humanize";
import { resolveModifyLevels } from "@/lib/orderTicketRules";
import { modifyPosition, type TradeScope } from "@/lib/tradeActions";
import type { InstantTradeSource } from "@/lib/instantTradeRouter";
import { cn } from "@/lib/utils";

export interface ModifyTarget {
  scope: TradeScope;
  ticket: string;
  symbol: string;
  side: "BUY" | "SELL" | null;
  entryPrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
}

export const REMOVE_LIVE_NOTE = "Removing a stop or target is not available on live yet: the live terminal treats an empty level as \"leave as is\". Set a new level instead.";

function fmt(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  return v.toFixed(abs >= 1000 ? 2 : abs >= 10 ? 3 : 5);
}

export function ModifySlTpDialog({ open, onOpenChange, target, source, onModified }: {
  open: boolean; onOpenChange: (o: boolean) => void; target: ModifyTarget | null; source: InstantTradeSource; onModified?: () => void;
}) {
  const { toast } = useToast();
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [removeSl, setRemoveSl] = useState(false);
  const [removeTp, setRemoveTp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !target) return;
    setSl(target.stopLoss != null ? String(target.stopLoss) : "");
    setTp(target.takeProfit != null ? String(target.takeProfit) : "");
    setRemoveSl(false);
    setRemoveTp(false);
    setErr(null);
  }, [open, target?.ticket, target?.stopLoss, target?.takeProfit]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!target) return null;
  const side = target.side ?? "BUY";
  const removalSupported = target.scope === "demo";
  // Side check only against a known current price (never the entry price).
  const levels = resolveModifyLevels({
    scope: target.scope, side, currentPrice: target.currentPrice,
    current: { stopLoss: target.stopLoss, takeProfit: target.takeProfit },
    slText: sl, tpText: tp, removeSl, removeTp,
  });
  const newSl = levels.newStopLoss, newTp = levels.newTakeProfit;
  const why = levels.error;
  const can = !busy && why == null;

  const submit = async () => {
    if (!can) return;
    setBusy(true); setErr(null);
    try {
      const r = await modifyPosition({ scope: target.scope, ticket: target.ticket, symbol: target.symbol, side: target.side, newStopLoss: newSl, newTakeProfit: newTp, source });
      if (r.ok) {
        toast({ title: `#${target.ticket} SL/TP sent`, description: target.scope === "live" ? "Change sent to your broker; the terminal confirms it." : "Changed on demo." });
        onModified?.();
        onOpenChange(false);
      } else {
        const h = humanizeReason(r.reason ?? r.status);
        setErr(h.description || r.reason || r.status);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" data-testid="modify-sltp">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <SlidersHorizontal className="h-4 w-4 text-amber-400" /> Modify #{target.ticket}
            <span className="ml-auto rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] uppercase text-txt-secondary">{target.scope}</span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            <span className={cn("font-semibold", side === "BUY" ? "text-emerald-300" : "text-rose-300")}>{side}</span> {target.symbol} @ {fmt(target.entryPrice)} · now {fmt(target.currentPrice)}.
            {side === "BUY" ? " Stop Loss below and Take Profit above the current price." : " Stop Loss above and Take Profit below the current price."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[11px] font-semibold text-rose-300">Stop Loss</span>
            <Input value={removeSl ? "" : sl} disabled={removeSl} onChange={(e) => setSl(e.target.value)} inputMode="decimal" placeholder={removeSl ? "removed" : "unchanged"} aria-label="New stop loss" className="mt-1 h-9 font-mono text-sm" data-testid="modify-sl" />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold text-emerald-300">Take Profit</span>
            <Input value={removeTp ? "" : tp} disabled={removeTp} onChange={(e) => setTp(e.target.value)} inputMode="decimal" placeholder={removeTp ? "removed" : "unchanged"} aria-label="New take profit" className="mt-1 h-9 font-mono text-sm" data-testid="modify-tp" />
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-txt-secondary" title={removalSupported ? undefined : REMOVE_LIVE_NOTE}>
            <input type="checkbox" checked={removeSl} disabled={!removalSupported || target.stopLoss == null} onChange={(e) => setRemoveSl(e.target.checked)} data-testid="modify-remove-sl" />
            Remove SL
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-txt-secondary" title={removalSupported ? undefined : REMOVE_LIVE_NOTE}>
            <input type="checkbox" checked={removeTp} disabled={!removalSupported || target.takeProfit == null} onChange={(e) => setRemoveTp(e.target.checked)} data-testid="modify-remove-tp" />
            Remove TP
          </label>
        </div>
        {!removalSupported && <p className="text-[10px] text-txt-secondary" data-testid="modify-remove-live-note">{REMOVE_LIVE_NOTE}</p>}
        <Button type="button" className="h-10 w-full" disabled={!can} onClick={() => void submit()} title={why ?? undefined} data-testid="modify-submit">
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Modify
        </Button>
        {(why || err) && <p className="text-[11px] text-rose-300" data-testid="modify-error">{err ?? why}</p>}
        <p className="text-[10px] text-txt-secondary">Leaving a field empty keeps that level as it is. The broker's own stop/freeze levels still apply.</p>
      </DialogContent>
    </Dialog>
  );
}

/** Row button: opens the SL/TP editor for one position. */
export function ModifySlTpButton({ target, source, onModified, className, compact = false }: {
  target: ModifyTarget; source: InstantTradeSource; onModified?: () => void; className?: string; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size={compact ? "icon" : "sm"} variant="outline" className={cn(compact ? "h-6 w-6" : "h-7 px-2 text-xs", className)} onClick={() => setOpen(true)}
        aria-label={`Set stop loss and take profit for ${target.ticket}`} title="Set / change Stop Loss and Take Profit" data-testid={`modify-sltp-open-${target.ticket}`}>
        <SlidersHorizontal className={compact ? "h-3.5 w-3.5" : "mr-1 h-3.5 w-3.5"} />{compact ? null : "SL/TP"}
      </Button>
      {open && <ModifySlTpDialog open={open} onOpenChange={setOpen} target={target} source={source} onModified={onModified} />}
    </>
  );
}
