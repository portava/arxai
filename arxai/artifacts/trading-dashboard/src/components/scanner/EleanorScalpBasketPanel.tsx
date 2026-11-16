import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, ChevronDown, ChevronUp, Layers, AlertTriangle } from "lucide-react";
import { useGetMeScalpBaskets } from "@workspace/api-client-react";
import type { MeScalpBasketsResp, ScalpBasket } from "@workspace/api-client-react";
import {
  ADD_ON_LABEL,
  ADD_ON_TONE,
  EXIT_URGENCY_LABEL,
  EXIT_URGENCY_TONE,
  FLAME_STAGE_LABEL,
  FLAME_STAGE_TONE,
  directionTone,
  fmtPrice,
  fmtScalpMoney,
} from "./scalpLabels";
import { useAssistantName } from "@/lib/assistant-name";
import { safeDate } from "@/lib/safeFormat";

// EleanorScalpBasketPanel (Phase 2) — manage-side intelligence for the open
// positions the user already holds. It groups open positions into baskets
// (symbol + direction), and shows Eleanor's live read on each: flame stage,
// exit urgency, and add-on guidance.
//
// SAFETY: 100% read-only / ALERT_ONLY. Eleanor never closes, modifies, or adds
// to a position from here — every line is guidance. No trade buttons.

function pl(v: number | null | undefined): { text: string; tone: string } {
  if (v == null || !Number.isFinite(v)) return { text: "—", tone: "text-muted-foreground" };
  const tone = v > 0 ? "text-success" : v < 0 ? "text-danger" : "text-muted-foreground";
  // Broker P/L is in the account's currency, which the basket does not carry —
  // so no "$" is assumed.
  return { text: fmtScalpMoney(v, null), tone };
}

function decimalsOf(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const s = String(v);
  if (/e/i.test(s)) return null;
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * Price digits for the basket's aggregates: the broker spec's digits from the
 * server, else the most decimals any of the basket's own reported prices carry
 * (capped at 8); null when neither says.
 */
export function basketPriceDigits(basket: ScalpBasket): number | null {
  const d = basket.digits;
  if (typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 8) return d;
  let best: number | null = null;
  const prices: Array<number | null | undefined> = [basket.currentPrice];
  for (const leg of basket.legs ?? []) {
    prices.push(leg.entryPrice, leg.currentPrice, leg.stopLoss, leg.takeProfit);
  }
  for (const p of prices) {
    const n = decimalsOf(p);
    if (n != null && (best == null || n > best)) best = n;
  }
  return best == null ? null : Math.min(best, 8);
}

function ageText(asOf: string, now: number): string | null {
  const t = new Date(asOf).getTime();
  if (!Number.isFinite(t)) return null;
  const sec = Math.round((now - t) / 1000);
  if (sec < 0) return null;
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m ago`;
}

// When the positions shown were last reported by the bridge. The server
// flags a reading older than 90 seconds (or with no recorded time) as stale:
// the rows, P/L, stops and advice then describe that reading, not now.
function PositionsReadingLine({ asOf, stale }: { asOf: string | null; stale: boolean }) {
  const age = asOf ? ageText(asOf, Date.now()) : null;
  const when = asOf ? `${safeDate(asOf, "datetime")}${age ? ` (${age})` : ""}` : null;
  if (stale) {
    return (
      <p
        className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-warning"
        data-testid="scalp-baskets-stale"
      >
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          {when
            ? `These positions are from your MT5 bridge's reading at ${when}, not live. `
            : "No reading time is recorded for these positions, so they may not be current. "}
          Some may have changed or closed since. The open P/L, stops and the exit and add-on advice below describe that reading.
        </span>
      </p>
    );
  }
  if (!when) return null;
  return (
    <p className="text-[11px] text-muted-foreground/70" data-testid="scalp-baskets-as-of">
      Positions as reported by your MT5 bridge at {when}.
    </p>
  );
}

function BasketRow({ basket, name, stale }: { basket: ScalpBasket; name: string; stale: boolean }) {
  const combined = pl(basket.combinedFloatingPl);
  const digits = basketPriceDigits(basket);
  return (
    <div
      className="rounded-lg border border-border/60 bg-card/40 p-3 space-y-2"
      data-testid="scalp-basket-row"
      data-symbol={basket.symbol}
      data-direction={basket.direction}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{basket.displayName}</span>
        <Badge variant="outline" className={directionTone(basket.direction)}>
          {basket.direction === "BUY" ? "Buy" : "Sell"}
        </Badge>
        <Badge
          variant="outline"
          className={FLAME_STAGE_TONE[basket.flame.flameStage]}
          data-testid="scalp-basket-flame"
          data-flame-stage={basket.flame.flameStage}
        >
          {FLAME_STAGE_LABEL[basket.flame.flameStage]}
        </Badge>
        <span className="ml-auto text-xs text-muted-foreground">
          {basket.entryCount} {basket.entryCount === 1 ? "entry" : "entries"} · {basket.totalVolume.toFixed(2)} lots
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <div>
          <span className="text-muted-foreground">Avg entry</span>
          <div className="font-mono" data-testid="scalp-basket-avg-entry">
            {basket.averageEntry > 0 ? fmtPrice(basket.averageEntry, digits) : "—"}
          </div>
        </div>
        <div>
          {/* The server's break-even is the volume-weighted average entry:
              no spread, commission or swap, so it is labelled as such. */}
          <span
            className="text-muted-foreground"
            data-testid="scalp-basket-break-even-label"
            title="The volume-weighted average entry. Spread, commission and swap are not included, so the real break-even is further away."
          >
            Break-even before costs
          </span>
          <div className="font-mono" data-testid="scalp-basket-break-even">
            {basket.breakEvenPrice > 0 ? fmtPrice(basket.breakEvenPrice, digits) : "—"}
          </div>
        </div>
        <div>
          <span className="text-muted-foreground">{stale ? "Open P/L (old reading)" : "Open P/L"}</span>
          <div className={`font-mono ${combined.tone}`}>{combined.text}</div>
        </div>
        <div>
          <span className="text-muted-foreground">Protection</span>
          <div className={basket.hasUnprotectedLeg ? "text-warning" : "text-success"}>
            {basket.hasUnprotectedLeg ? "Has unprotected leg" : "All have stops"}
          </div>
        </div>
      </div>

      {/* Exit urgency — ALERT_ONLY guidance */}
      <div
        className="rounded-md border border-border/40 p-2 space-y-1"
        data-testid="scalp-basket-exit"
        data-exit-urgency={basket.exit.urgency}
      >
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={EXIT_URGENCY_TONE[basket.exit.urgency]}>
            {EXIT_URGENCY_LABEL[basket.exit.urgency]}
          </Badge>
          <span className="text-sm font-medium">{basket.exit.headline}</span>
        </div>
        <p className="text-xs text-muted-foreground">{basket.exit.detail}</p>
        <p className="text-[11px] text-muted-foreground/70">
          {name} only advises — she never closes a position for you.
        </p>
      </div>

      {/* Add-on guidance */}
      <div
        className="rounded-md border border-border/40 p-2 space-y-1"
        data-testid="scalp-basket-addon"
        data-addon={basket.addOn.recommendation}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={ADD_ON_TONE[basket.addOn.recommendation]}>
            {ADD_ON_LABEL[basket.addOn.recommendation]}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {basket.addOn.usedAddOns}/{basket.addOn.maxAddOns} adds used
            {basket.addOn.remainingAddOns > 0 ? ` · ${basket.addOn.remainingAddOns} left` : ""}
          </span>
          {basket.addOn.revengeGuardTriggered && (
            <span className="flex items-center gap-1 text-xs text-danger">
              <AlertTriangle className="h-3 w-3" /> Revenge guard
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{basket.addOn.reason}</p>
      </div>
    </div>
  );
}

// An empty list is only "no open positions" when positions were actually
// read. The Position Manager reads live and demo MT5 positions only.
function emptyStateCopy(data: MeScalpBasketsResp, name: string): string {
  if (data.accountMode === "PAPER") {
    return "Your account is in Paper mode. The Position Manager covers live and demo MT5 positions only, so your paper positions are not shown or managed here.";
  }
  if (data.accountMode === "NONE") {
    return "No live or demo account is active, so no MT5 positions were read here.";
  }
  if (data.positionsMeasured === false) {
    return data.positionsNote ?? "Your open positions were not read here, so this is not a count of zero.";
  }
  const book = data.accountMode === "DEMO" ? "demo" : "live";
  return `No open ${book} MT5 positions to manage. Once you're in a trade, ${name} will watch the flame, exit urgency, and whether it's sane to add.`;
}

export function EleanorScalpBasketPanel() {
  const [collapsed, setCollapsed] = useState(false);
  const { name } = useAssistantName();
  const baskets = useGetMeScalpBaskets({
    query: {
      queryKey: ["me-scalp-baskets"],
      refetchInterval: 15_000,
      refetchIntervalInBackground: false,
    },
  });
  const data = baskets.data;
  // React Query keeps the last successful data after a failed refetch. The
  // latest read failed, so those positions (which may since have closed) and
  // their exit / add-on advice are not shown as current.
  const list = baskets.isError ? [] : data?.baskets ?? [];
  // The server says the open positions for this account mode were not read
  // (for example no MT5 snapshot is stored for this user). An empty list is
  // then not "no positions".
  const positionsUnread = !!data && !baskets.isError && data.positionsMeasured === false;

  return (
    <Card data-testid="eleanor-scalp-baskets" className="rounded-2xl border-eleanor/25 bg-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-eleanor/15 text-eleanor ring-1 ring-eleanor/25">
              <Layers className="h-[18px] w-[18px]" />
            </span>
            {name} Position Manager
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => baskets.refetch()}
              disabled={baskets.isFetching}
              data-testid="eleanor-scalp-baskets-refresh"
            >
              <RefreshCw className={`h-4 w-4 ${baskets.isFetching ? "animate-spin" : ""}`} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => setCollapsed((c) => !c)}
              data-testid="eleanor-scalp-baskets-collapse"
            >
              {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </CardHeader>

      {!collapsed && (
        <CardContent className="space-y-3">
          {baskets.isError && (
            <p className="text-sm text-danger">
              {name} couldn't read your open positions right now, so no position advice is shown. Try Refresh in a moment.
            </p>
          )}
          {baskets.isPending && !data && (
            <p className="text-sm text-muted-foreground animate-pulse">
              {name} is reading your open positions…
            </p>
          )}
          {positionsUnread && (
            <div
              className="rounded-md border border-warning/40 bg-warning/5 p-2 text-sm text-warning"
              data-testid="eleanor-scalp-baskets-not-measured"
            >
              <p className="font-medium">
                Your open positions were not read, so {name} cannot say whether you have any to manage.
              </p>
              <p className="mt-1 text-xs text-muted-foreground" data-testid="scalp-baskets-empty">
                {data ? emptyStateCopy(data, name) : null}
              </p>
            </div>
          )}
          {data && !baskets.isError && !positionsUnread && list.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="scalp-baskets-empty">
              {emptyStateCopy(data, name)}
            </p>
          )}
          {list.length > 0 && (
            <PositionsReadingLine asOf={data?.positionsAsOf ?? null} stale={data?.positionsStale === true} />
          )}
          {list.map((b) => (
            <BasketRow
              key={`${b.symbol}:${b.direction}`}
              basket={b}
              name={name}
              stale={data?.positionsStale === true}
            />
          ))}
        </CardContent>
      )}
    </Card>
  );
}

export default EleanorScalpBasketPanel;
