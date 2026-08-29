// Phase 25 — Full Order Ticket UI.
//
// Supports all 8 canonical order types: Buy/Sell × Market/Limit/Stop/StopLimit.
// Per type the correct fields render; an instant client-side preview runs the
// same direction/relationship rules as the backend validator (a strict subset —
// the authoritative validator still runs on submit). Market orders go to
// /api/trade/place; pending orders go to /api/me/pending-order-draft. Pending
// drafts are NEVER executable today (paper-only lock); the response surfaces
// the honest blocked reason.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

const SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "Volatility 75 Index", "US30", "NAS100", "AAPL", "TSLA"];

type OrderType =
  | "BUY_MARKET" | "SELL_MARKET"
  | "BUY_LIMIT" | "SELL_LIMIT"
  | "BUY_STOP" | "SELL_STOP"
  | "BUY_STOP_LIMIT" | "SELL_STOP_LIMIT";

const ORDER_LABELS: Record<OrderType, string> = {
  BUY_MARKET: "Buy Market",
  SELL_MARKET: "Sell Market",
  BUY_LIMIT: "Buy Limit",
  SELL_LIMIT: "Sell Limit",
  BUY_STOP: "Buy Stop",
  SELL_STOP: "Sell Stop",
  BUY_STOP_LIMIT: "Buy Stop-Limit",
  SELL_STOP_LIMIT: "Sell Stop-Limit",
};

function isMarket(t: OrderType) { return t === "BUY_MARKET" || t === "SELL_MARKET"; }
function isStopLimit(t: OrderType) { return t === "BUY_STOP_LIMIT" || t === "SELL_STOP_LIMIT"; }
function dirOf(t: OrderType): "BUY" | "SELL" { return t.startsWith("BUY") ? "BUY" : "SELL"; }

interface Preview {
  errors: string[];
  warnings: string[];
  riskReward: number | null;
  effectiveEntry: number | null;
  label: "Live-Eligible" | "Paper" | "Draft" | "Blocked";
}

function runPreview(input: {
  orderType: OrderType;
  lot: number;
  current: number | null;
  entry: number | null;
  trigger: number | null;
  limit: number | null;
  sl: number | null;
  tp: number | null;
}): Preview {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { orderType: t, lot, current, entry, trigger, limit, sl, tp } = input;
  const dir = dirOf(t);

  if (!Number.isFinite(lot) || lot <= 0) errors.push("Lot size must be positive.");

  let eff: number | null = null;
  if (isMarket(t)) {
    if (current == null) { warnings.push("Live market price unavailable — SL/TP direction checks skipped."); }
    else { eff = current; }
  } else if (isStopLimit(t)) {
    if (trigger == null) errors.push("Stop-Limit requires a Stop Trigger Price.");
    if (limit == null) errors.push("Stop-Limit requires a Stop-Limit Price.");
    eff = limit;
    if (current != null && trigger != null) {
      if (t === "BUY_STOP_LIMIT" && trigger <= current) errors.push("Buy Stop-Limit trigger must be ABOVE current ask.");
      if (t === "SELL_STOP_LIMIT" && trigger >= current) errors.push("Sell Stop-Limit trigger must be BELOW current bid.");
    }
    if (trigger != null && limit != null) {
      if (t === "BUY_STOP_LIMIT" && limit >= trigger) errors.push("Buy Stop-Limit limit price must be STRICTLY BELOW the trigger.");
      if (t === "SELL_STOP_LIMIT" && limit <= trigger) errors.push("Sell Stop-Limit limit price must be STRICTLY ABOVE the trigger.");
    }
  } else {
    if (entry == null) errors.push("Pending orders require an Entry Price.");
    eff = entry;
    if (current != null && entry != null) {
      if (t === "BUY_LIMIT" && entry >= current) errors.push("Buy Limit entry must be BELOW current market.");
      if (t === "SELL_LIMIT" && entry <= current) errors.push("Sell Limit entry must be ABOVE current market.");
      if (t === "BUY_STOP" && entry <= current) errors.push("Buy Stop entry must be ABOVE current market.");
      if (t === "SELL_STOP" && entry >= current) errors.push("Sell Stop entry must be BELOW current market.");
    }
  }

  if (eff != null) {
    if (sl != null) {
      if (dir === "BUY" && sl >= eff) errors.push("Stop Loss must be BELOW entry for a BUY.");
      if (dir === "SELL" && sl <= eff) errors.push("Stop Loss must be ABOVE entry for a SELL.");
    }
    if (tp != null) {
      if (dir === "BUY" && tp <= eff) errors.push("Take Profit must be ABOVE entry for a BUY.");
      if (dir === "SELL" && tp >= eff) errors.push("Take Profit must be BELOW entry for a SELL.");
    }
  }

  let rr: number | null = null;
  if (eff != null && sl != null && tp != null) {
    const risk = Math.abs(eff - sl);
    const reward = Math.abs(tp - eff);
    if (risk > 0) rr = Number((reward / risk).toFixed(2));
  }

  // Label = always "Paper" today (paper-only lock); pending drafts → "Draft";
  // errors → "Blocked". Live-Eligible is never returned by the frontend
  // because the backend live lock is the source of truth.
  let label: Preview["label"] = "Paper";
  if (errors.length > 0) label = "Blocked";
  else if (!isMarket(t)) label = "Draft";

  return { errors, warnings, riskReward: rr, effectiveEntry: eff, label };
}

export function PaperOrderTicket({ accountId: _accountId }: { accountId: number | null }) {
  const qc = useQueryClient();
  const [symbol, setSymbol] = useState(SYMBOLS[0]);
  const [orderType, setOrderType] = useState<OrderType>("BUY_MARKET");
  const [lot, setLot] = useState(0.1);
  const [entry, setEntry] = useState<string>("");
  const [trigger, setTrigger] = useState<string>("");
  const [limit, setLimit] = useState<string>("");
  const [sl, setSl] = useState<string>("");
  const [tp, setTp] = useState<string>("");
  const [current, setCurrent] = useState<string>("");

  const num = (s: string): number | null => {
    if (!s.trim()) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  const preview = useMemo<Preview>(() => runPreview({
    orderType, lot,
    current: num(current),
    entry: num(entry),
    trigger: num(trigger),
    limit: num(limit),
    sl: num(sl),
    tp: num(tp),
  }), [orderType, lot, current, entry, trigger, limit, sl, tp]);

  const place = useMutation({
    mutationFn: async () => {
      const dir = dirOf(orderType);
      if (isMarket(orderType)) {
        const r = await fetch("/api/trade/place", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "SIMULATED",
            symbol,
            side: dir,
            lotSize: lot,
            stopLoss: num(sl),
            takeProfit: num(tp),
            confirmedByUser: true,
          }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || j.result?.reason || "Trade place failed");
        return { kind: "market", result: j };
      }
      // Pending order — goes to draft endpoint; backend force-locks executable:false.
      const r = await fetch("/api/me/pending-order-draft", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderType,
          symbol,
          lotSize: lot,
          entryPrice: num(entry),
          stopTriggerPrice: num(trigger),
          stopLimitPrice: num(limit),
          stopLoss: num(sl),
          takeProfit: num(tp),
          currentPrice: num(current),
          requestedMode: "SIMULATED",
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok && !j.blocked) throw new Error(j.error || "Pending order draft failed");
      return { kind: "pending", result: j };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["paper-orders"] });
      qc.invalidateQueries({ queryKey: ["paper-active"] });
      qc.invalidateQueries({ queryKey: ["/me/pending-order-drafts"] });
    },
  });

  const submitDisabled = preview.errors.length > 0 || place.isPending;
  const showEntry = !isMarket(orderType) && !isStopLimit(orderType);
  const showTriggerLimit = isStopLimit(orderType);

  const toneByLabel: Record<Preview["label"], string> = {
    "Live-Eligible": "bg-success/20 text-success border-success/40",
    Paper: "bg-warning/20 text-warning border-warning/40",
    Draft: "bg-ruby/20 text-ruby border-ruby/40",
    Blocked: "bg-danger/20 text-danger border-danger/40",
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-4" data-testid="order-ticket">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Order Ticket</h3>
        <span className={`rounded border px-2 py-0.5 text-[10px] font-semibold ${toneByLabel[preview.label]}`} data-testid="order-ticket-label">
          {preview.label === "Paper" ? "DEMO" : preview.label.toUpperCase()}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <label className="col-span-2">
          <span className="text-txt-secondary">Order type</span>
          <select
            value={orderType}
            onChange={(e) => setOrderType(e.target.value as OrderType)}
            className="w-full rounded border border-border bg-background px-2 py-1 text-foreground"
            data-testid="select-order-type"
          >
            {(Object.keys(ORDER_LABELS) as OrderType[]).map((t) => (
              <option key={t} value={t}>{ORDER_LABELS[t]}</option>
            ))}
          </select>
        </label>

        <label>
          <span className="text-txt-secondary">Symbol</span>
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-1 text-foreground">
            {SYMBOLS.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label>
          <span className="text-txt-secondary">Lot size</span>
          <input type="number" step="0.01" min="0.01" value={lot} onChange={(e) => setLot(Number(e.target.value))} className="w-full rounded border border-border bg-background px-2 py-1 text-foreground" />
        </label>

        <label className="col-span-2">
          <span className="text-txt-secondary">Current price (live) <span className="text-[10px] text-warning">— leave blank if not available</span></span>
          <input type="number" step="0.00001" value={current} placeholder="e.g. 1.08500" onChange={(e) => setCurrent(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-1 text-foreground" />
        </label>

        {showEntry && (
          <label className="col-span-2">
            <span className="text-txt-secondary">Entry price</span>
            <input type="number" step="0.00001" value={entry} onChange={(e) => setEntry(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-1 text-foreground" data-testid="input-entry" />
          </label>
        )}

        {showTriggerLimit && (
          <>
            <label>
              <span className="text-txt-secondary">Stop trigger</span>
              <input type="number" step="0.00001" value={trigger} onChange={(e) => setTrigger(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-1 text-foreground" data-testid="input-trigger" />
            </label>
            <label>
              <span className="text-txt-secondary">Stop-limit price</span>
              <input type="number" step="0.00001" value={limit} onChange={(e) => setLimit(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-1 text-foreground" data-testid="input-limit" />
            </label>
          </>
        )}

        <label>
          <span className="text-txt-secondary">Stop Loss</span>
          <input type="number" step="0.00001" value={sl} onChange={(e) => setSl(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-1 text-foreground" data-testid="input-sl" />
        </label>
        <label>
          <span className="text-txt-secondary">Take Profit</span>
          <input type="number" step="0.00001" value={tp} onChange={(e) => setTp(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-1 text-foreground" data-testid="input-tp" />
        </label>
      </div>

      <div className="space-y-1 rounded border border-border bg-background/60 p-2 text-[11px]">
        <div className="flex justify-between text-txt-secondary">
          <span>R/R preview</span>
          <span className="font-mono text-foreground" data-testid="rr-preview">{preview.riskReward == null ? "—" : `${preview.riskReward}:1`}</span>
        </div>
        <div className="flex justify-between text-txt-secondary">
          <span>Effective entry</span>
          <span className="font-mono text-foreground">{preview.effectiveEntry == null ? "—" : preview.effectiveEntry}</span>
        </div>
        {!current.trim() && (
          <p className="text-warning">Live price unavailable — direction checks against market are skipped. Real submission of a pending order may still be rejected at execution time.</p>
        )}
        {preview.warnings.map((w, i) => <p key={`w${i}`} className="text-warning">{w}</p>)}
        {preview.errors.map((e, i) => <p key={`e${i}`} className="text-danger" data-testid={`error-${i}`}>{e}</p>)}
      </div>

      <button
        onClick={() => place.mutate()}
        disabled={submitDisabled}
        className="w-full rounded bg-warning px-3 py-2 text-xs font-semibold text-white hover:bg-warning disabled:opacity-50"
        data-testid="button-place-order"
      >
        {place.isPending ? "Placing…" : isMarket(orderType) ? `Place SIMULATED ${ORDER_LABELS[orderType]}` : `Save ${ORDER_LABELS[orderType]} Draft`}
      </button>

      {place.isError && <p className="text-[11px] text-danger">{(place.error as Error).message}</p>}

      {place.isSuccess && place.data && (
        <div className="rounded border border-border bg-background/60 p-2 text-[11px]">
          {place.data.kind === "market" ? (
            <p className="text-success">Market order accepted.</p>
          ) : (
            <>
              <p className="text-ruby">Draft saved.</p>
              <p className="text-txt-secondary mt-1">{place.data.result.reason ?? "Draft validated. Not sent to broker."}</p>
              <p className="text-warning mt-1">
                {place.data.result.executable ? "Ready to send" : "Not ready to send"}
                {place.data.result.pendingStatus ? ` · ${place.data.result.pendingStatus}` : ""}
              </p>
            </>
          )}
        </div>
      )}

      <p className="text-[10px] text-warning">
        Live execution remains system-locked. Market orders execute as SIMULATED; pending orders save as validated DRAFTS until the MT5 bridge supports them and live trading is unlocked.
      </p>
    </div>
  );
}
