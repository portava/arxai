// Chart-side trade entry panel — sits next to the TradingView chart and
// lets the user pre-stage a live order ticket from the symbol the chart
// is currently showing.
//
// SAFETY:
//  - This component NEVER fires an order. It only opens LiveTradeTicket
//    (which itself requires armed status, one-click toggle OR manual
//    typed confirmation, then runs every Phase B / master / one-click /
//    exposure / cooldown gate on the server).
//  - All copy is user-friendly (no raw backend codes).
//  - High-impact economic events for the symbol's currencies are surfaced
//    via EventImpactBadge so the user can see news risk before opening
//    the ticket.

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Info } from "lucide-react";
import { useChartSymbol, bareSymbol } from "@/lib/use-chart-symbol";
import { ChartFeedConfidence } from "@/components/charts/ChartFeedConfidence";
import { LiveTradeTicket } from "@/components/live/LiveTradeTicket";
import { LiveSharedTradeTicket } from "@/components/live/LiveSharedTradeTicket";
import { useMasterLiveAccess } from "@/components/live/MasterLiveAccessGuard";
import { EventImpactBadge } from "@/components/news/EventImpactBadge";
import { HighImpactEventBanner } from "@/components/news/HighImpactEventBanner";

// A setup-preview "Use this setup" prefill. `token` changes on every fresh
// pick so the same setup can be re-applied. This NEVER places an order — it only
// opens the existing gated ticket pre-set to the preview's side + SL/TP, which
// the user must still review and confirm.
export interface ChartTradePrefill {
  token: number;
  side: "BUY" | "SELL";
  stopLoss: number | null;
  takeProfit: number | null;
  /**
   * Human-readable attribution for a setup-preview-sourced prefill: where the
   * levels came from (AI setup preview), the setup type, confidence, and the
   * feed-trust basis they were produced against. Surfaced in the ticket UI so a
   * pre-filled order never hides the origin/freshness of its levels.
   */
  sourceNote?: string | null;
}

export function ChartTradeEntry({ prefill }: { prefill?: ChartTradePrefill | null } = {}) {
  // Pulls from the shared chart-symbol bus — the SAME source of truth
  // the chart, scanner focus panel, AI assist card, ticket and ruby
  // explanation all read from. Picking a symbol in any of them flips
  // this card in the same paint.
  const [chartSymbol] = useChartSymbol();
  const symbol = bareSymbol(chartSymbol);
  const access = useMasterLiveAccess();
  const accessLoading = !access.loaded;
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  // Freeze which ticket variant to use at open-time, so a late
  // access-load resolution can never swap the modal underneath the
  // user (LiveTradeTicket → LiveSharedTradeTicket flicker).
  const [openedAsShared, setOpenedAsShared] = useState(false);
  // Whether the CURRENT open was initiated by an AI/Ruby setup-preview
  // "Use this setup" (vs a manual Buy/Sell button). When true, the shared
  // ticket's one-click auto-confirm is suppressed so a drawing can never
  // auto-dispatch — the user must click Confirm explicitly.
  const [openedFromPrefill, setOpenedFromPrefill] = useState(false);

  const openTicket = (s: "BUY" | "SELL", fromPrefill = false) => {
    if (accessLoading) return; // wait until access resolves; button disabled below
    setSide(s);
    setOpenedAsShared(access.canTrade === true);
    setOpenedFromPrefill(fromPrefill);
    setOpen(true);
  };

  // A fresh setup-preview prefill (new token) opens the gated ticket pre-set to
  // the preview's side. The SL/TP values are passed to the ticket via
  // prefillSltp below. This only OPENS + PRE-FILLS — the user still reviews and
  // confirms, and every server gate runs on dispatch. Waits for access to load.
  useEffect(() => {
    if (!prefill || accessLoading) return;
    openTicket(prefill.side, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.token, accessLoading]);

  return (
    <>
      <Card className="border-border" data-testid="chart-trade-entry">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <CardTitle className="text-base">Trade from chart</CardTitle>
              <CardDescription className="text-xs">
                Opens trade ticket. Final confirmation required.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <ChartFeedConfidence symbol={symbol} />
              <Badge variant="outline" className="font-mono" data-testid="text-chart-trade-symbol">
                {symbol}
              </Badge>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          <HighImpactEventBanner />

          <div className="flex flex-wrap items-center gap-2">
            <EventImpactBadge symbol={symbol} hoursAhead={2} />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="default"
              className="bg-success hover:bg-success text-white"
              onClick={() => openTicket("BUY")}
              disabled={accessLoading}
              data-testid="btn-chart-open-buy"
            >
              <TrendingUp className="h-4 w-4 mr-2" />
              Buy {symbol}
            </Button>
            <Button
              variant="default"
              className="bg-danger hover:bg-danger text-white"
              onClick={() => openTicket("SELL")}
              disabled={accessLoading}
              data-testid="btn-chart-open-sell"
            >
              <TrendingDown className="h-4 w-4 mr-2" />
              Sell {symbol}
            </Button>
          </div>

          {openedFromPrefill && prefill?.sourceNote && (
            <p
              className="text-xs text-ruby/90 flex items-start gap-1.5 rounded-md border border-ruby/25 bg-ruby/5 p-2"
              data-testid="chart-trade-prefill-source"
            >
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              {prefill.sourceNote}. Levels are pre-filled for review only — confirm in the ticket to place.
            </p>
          )}

          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <Info className="h-3 w-3 mt-0.5 shrink-0" />
            Use the chart's symbol picker to switch markets. The trade ticket will inherit it.
          </p>
        </CardContent>
      </Card>

      {/* Single-modal flow: approved live-shared users get the shared
          ticket directly (no second popup, no "Use LIVE SHARED above"
          intermediate). Everyone else gets the standard live ticket.
          The variant is frozen at open-time (openedAsShared) so a late
          access resolution cannot swap the modal underneath the user. */}
      {openedAsShared ? (
        <LiveSharedTradeTicket
          open={open}
          onOpenChange={setOpen}
          defaultSymbol={symbol}
          defaultSide={side}
          prefillSltp={prefill ? { token: prefill.token, stopLoss: prefill.stopLoss, takeProfit: prefill.takeProfit } : null}
          suppressAutoConfirm={openedFromPrefill}
        />
      ) : (
        <LiveTradeTicket
          open={open}
          onOpenChange={setOpen}
          defaultSymbol={symbol}
          defaultSide={side}
          sourcePage="LIVE_CHART_TRADE_ENTRY"
          prefillSltp={prefill ? { token: prefill.token, stopLoss: prefill.stopLoss, takeProfit: prefill.takeProfit } : null}
        />
      )}
    </>
  );
}
