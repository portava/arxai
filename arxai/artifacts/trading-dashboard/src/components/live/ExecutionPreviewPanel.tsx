// Execution Cost & Survivability preview (Task #196).
//
// A READ-ONLY advisory panel that surfaces the honest pre-trade execution
// economics for the order the user is configuring in the live trade ticket:
// spread cost, lot-scaled slippage, expected fill range, starting drawdown
// (pain-before-profit), break-even, after-cost TP/SL & R:R, survivability,
// account impact, an order-type recommendation, multi-entry exposure, and a
// broker-condition verdict.
//
// SAFETY: this panel places NO order and touches NO safety surface. It is
// purely informational — the full 16-gate evaluator still runs on /execute.
// All numbers come from the server (spec-derived broker truth where reported,
// the standard contract model otherwise); degraded inputs are labelled. No
// internal enum tokens are shown — every string is plain English.

import { useEffect, useRef, useState } from "react";
import { Loader2, AlertTriangle, ShieldCheck, ShieldAlert, Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  getLiveSharedExecutionPreview,
  type LiveExecutionPreviewResult,
} from "@/lib/api/liveShared";
import type {
  ExecutionPreview,
  ExecutionOrderType,
  BrokerConditionVerdict,
} from "@workspace/domain/execution-preview";

type Props = {
  enabled: boolean;
  symbol: string;
  side: "BUY" | "SELL";
  lots: number;
  stopLoss: number | null;
  takeProfit: number | null;
  entry?: number | null;
  orderType?: ExecutionOrderType;
};

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const formatted = abs < 100 ? abs.toFixed(2) : abs.toFixed(0);
  return `${n < 0 ? "-" : ""}$${formatted}`;
}

function pts(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(n < 10 ? 1 : 0)} pts`;
}

function price(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toPrecision(6).replace(/\.?0+$/, "");
}

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}

const ORDER_TYPE_LABEL: Record<ExecutionOrderType, string> = {
  MARKET: "Market",
  LIMIT: "Limit",
  STOP: "Stop",
};

const VERDICT_LABEL: Record<BrokerConditionVerdict, string> = {
  OK: "Good conditions",
  DOWNGRADE: "Conditions degraded",
  BLOCK: "Hold off — poor conditions",
};

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-[11px] font-mono text-foreground text-right">
        {value}
        {hint && <span className="ml-1 text-muted-foreground font-sans">{hint}</span>}
      </span>
    </div>
  );
}

export function ExecutionPreviewPanel(props: Props) {
  const { enabled, symbol, side, lots, stopLoss, takeProfit, entry, orderType } = props;
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<ExecutionPreview | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const runRef = useRef(0);

  useEffect(() => {
    const sym = symbol.trim().toUpperCase();
    if (!enabled || !sym || !(Number.isFinite(lots) && lots > 0)) {
      setPreview(null);
      setErrorMsg(null);
      return;
    }
    const runId = ++runRef.current;
    const t = setTimeout(() => {
      setLoading(true);
      setErrorMsg(null);
      void (async () => {
        try {
          const r: LiveExecutionPreviewResult = await getLiveSharedExecutionPreview({
            symbol: sym,
            side,
            orderType: orderType ?? "MARKET",
            lots,
            entry: entry ?? null,
            stopLoss,
            takeProfit,
          });
          if (runId !== runRef.current) return;
          if (r.ok) {
            setPreview(r.preview);
            setErrorMsg(null);
          } else {
            setPreview(null);
            setErrorMsg(
              r.userMessage ?? "An execution-cost estimate isn't available right now.",
            );
          }
        } catch {
          if (runId !== runRef.current) return;
          setPreview(null);
          setErrorMsg("Couldn't estimate execution cost. The order is unaffected.");
        } finally {
          if (runId === runRef.current) setLoading(false);
        }
      })();
    }, 400);
    return () => clearTimeout(t);
  }, [enabled, symbol, side, lots, stopLoss, takeProfit, entry, orderType]);

  if (!enabled) return null;

  if (loading && !preview) {
    return (
      <div
        className="rounded border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-muted-foreground flex items-center gap-2"
        data-testid="exec-preview-loading"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Estimating execution cost…
      </div>
    );
  }

  if (errorMsg && !preview) {
    return (
      <Alert className="border-zinc-700/50 bg-zinc-900/40" data-testid="exec-preview-error">
        <Info className="h-4 w-4 text-muted-foreground" />
        <AlertDescription className="text-xs text-muted-foreground">{errorMsg}</AlertDescription>
      </Alert>
    );
  }

  if (!preview) return null;

  const p = preview;
  const verdictTone =
    p.brokerCondition.verdict === "OK"
      ? "border-emerald-700/40 bg-emerald-950/20"
      : p.brokerCondition.verdict === "DOWNGRADE"
        ? "border-amber-500/40 bg-amber-500/5"
        : "border-rose-700/50 bg-rose-950/20";
  const VerdictIcon =
    p.brokerCondition.verdict === "OK"
      ? ShieldCheck
      : p.brokerCondition.verdict === "DOWNGRADE"
        ? ShieldAlert
        : AlertTriangle;
  const verdictIconTone =
    p.brokerCondition.verdict === "OK"
      ? "text-emerald-400"
      : p.brokerCondition.verdict === "DOWNGRADE"
        ? "text-amber-300"
        : "text-rose-300";

  const recommendedOrder = p.orderTypes.find((o) => o.recommended) ?? p.orderTypes[0];

  return (
    <div
      className="rounded border border-zinc-800 bg-zinc-900/40 p-3 space-y-3"
      data-testid="exec-preview-panel"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground">Execution cost & survivability</span>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </div>

      {/* Broker-condition verdict — friendly label, never a raw token. */}
      <div
        className={`flex items-start gap-2 rounded border p-2 ${verdictTone}`}
        data-testid="exec-preview-verdict"
      >
        <VerdictIcon className={`h-4 w-4 mt-0.5 ${verdictIconTone}`} />
        <div className="space-y-0.5">
          <div className="text-[11px] font-medium text-foreground">
            {VERDICT_LABEL[p.brokerCondition.verdict]}
          </div>
          {p.brokerCondition.reasons.map((r, i) => (
            <div key={i} className="text-[11px] text-muted-foreground">{r}</div>
          ))}
        </div>
      </div>

      {/* Cost to enter. */}
      <div>
        <div className="text-[11px] font-medium text-muted-foreground mb-0.5">Cost to enter</div>
        <Row label="Spread cost" value={money(p.spreadCost.money)} hint={pts(p.spreadCost.points)} />
        <Row
          label="Slippage (expected)"
          value={money(p.slippage.expectedMoney)}
          hint={pts(p.slippage.expectedPoints)}
        />
        <Row label="Slippage (worst)" value={money(p.slippage.worstMoney)} hint={pts(p.slippage.worstPoints)} />
        <div className="text-[10px] text-muted-foreground mt-0.5">{p.slippage.note}</div>
      </div>

      {/* Pain before profit + break-even. */}
      <div>
        <div className="text-[11px] font-medium text-muted-foreground mb-0.5">Starting position</div>
        <Row
          label="Starting drawdown"
          value={money(p.startingDrawdown.money)}
          hint={pts(p.startingDrawdown.points)}
        />
        <Row label="Break-even move" value={pts(p.breakEven.points)} hint={money(p.breakEven.money)} />
        {p.expectedFillRange && (
          <Row
            label="Expected fill"
            value={price(p.expectedFillRange.expected)}
            hint={`${price(p.expectedFillRange.low)}–${price(p.expectedFillRange.high)}`}
          />
        )}
      </div>

      {/* After-cost outcomes. */}
      {(p.afterCost.stopLossMoney != null || p.afterCost.takeProfitMoney != null) && (
        <div>
          <div className="text-[11px] font-medium text-muted-foreground mb-0.5">After cost</div>
          <Row label="Loss at stop loss" value={money(p.afterCost.stopLossMoney)} />
          <Row label="Gain at take profit" value={money(p.afterCost.takeProfitMoney)} />
          {p.afterCost.riskRewardRatio != null && (
            <Row
              label="Reward : risk"
              value={p.afterCost.riskRewardRatio.toFixed(2)}
              hint={
                p.afterCost.grossRiskRewardRatio != null
                  ? `${p.afterCost.grossRiskRewardRatio.toFixed(2)} before cost`
                  : undefined
              }
            />
          )}
        </div>
      )}

      {/* Survivability. */}
      <div>
        <div className="text-[11px] font-medium text-muted-foreground mb-0.5">
          Survivability {Number.isFinite(p.survivability.score) ? `(${Math.round(p.survivability.score)}/100)` : ""}
        </div>
        {p.survivability.stopDistanceAtr != null && (
          <Row label="Stop distance" value={`${p.survivability.stopDistanceAtr.toFixed(2)} ATR`} />
        )}
        <div className="text-[10px] text-muted-foreground">{p.survivability.note}</div>
      </div>

      {/* Account impact. */}
      {(p.accountImpact.riskMoney != null || p.accountImpact.marginRequired != null) && (
        <div>
          <div className="text-[11px] font-medium text-muted-foreground mb-0.5">Account impact</div>
          <Row
            label="Money at risk"
            value={money(p.accountImpact.riskMoney)}
            hint={p.accountImpact.riskPctOfBalance != null ? pct(p.accountImpact.riskPctOfBalance) : undefined}
          />
          {p.accountImpact.marginRequired != null && (
            <Row
              label="Margin required"
              value={money(p.accountImpact.marginRequired)}
              hint={p.accountImpact.marginPctOfBalance != null ? pct(p.accountImpact.marginPctOfBalance) : undefined}
            />
          )}
          {p.accountImpact.note && (
            <div className="text-[10px] text-muted-foreground mt-0.5">{p.accountImpact.note}</div>
          )}
        </div>
      )}

      {/* Order-type recommendation. */}
      {recommendedOrder && (
        <div>
          <div className="text-[11px] font-medium text-muted-foreground mb-0.5">Order type</div>
          <Row
            label="Recommended"
            value={ORDER_TYPE_LABEL[recommendedOrder.type]}
            hint={`${Math.round(recommendedOrder.fillLikelihood)}% fill`}
          />
          <div className="text-[10px] text-muted-foreground">{recommendedOrder.note}</div>
        </div>
      )}

      {/* Multi-entry exposure + scaling. */}
      {p.multiEntry && p.multiEntry.hasExistingExposure && (
        <div data-testid="exec-preview-multientry">
          <div className="text-[11px] font-medium text-muted-foreground mb-0.5">Existing exposure</div>
          <Row label="Combined size" value={`${p.multiEntry.combinedLots} lots`} />
          {p.multiEntry.combinedRiskMoney != null && (
            <Row label="Combined risk" value={money(p.multiEntry.combinedRiskMoney)} />
          )}
          <div className="text-[10px] text-muted-foreground mt-0.5">{p.multiEntry.scalingNote}</div>
        </div>
      )}

      {/* Hard blockers. */}
      {p.blockers.length > 0 && (
        <Alert className="border-rose-700/50 bg-rose-950/20" data-testid="exec-preview-blockers">
          <AlertTriangle className="h-4 w-4 text-rose-300" />
          <AlertTitle className="text-xs text-rose-200">This order isn't viable as set up</AlertTitle>
          <AlertDescription className="text-[11px] text-rose-200/90">
            <ul className="list-disc pl-4 space-y-0.5">
              {p.blockers.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* Non-blocking warnings. */}
      {p.warnings.length > 0 && (
        <div className="space-y-0.5" data-testid="exec-preview-warnings">
          {p.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[11px] text-amber-200/90">
              <AlertTriangle className="h-3 w-3 mt-0.5 text-amber-300 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* Data-quality + disclaimer. */}
      {p.dataQuality.degraded && p.dataQuality.notes.length > 0 && (
        <div className="text-[10px] text-muted-foreground border-t border-zinc-800 pt-1.5">
          {p.dataQuality.notes.map((n, i) => <div key={i}>{n}</div>)}
        </div>
      )}
      <div className="text-[10px] text-muted-foreground/80 italic">{p.disclaimer}</div>
    </div>
  );
}
