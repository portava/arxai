import { useEffect, useRef } from "react";
import { createChart, CandlestickSeries, createSeriesMarkers, ColorType, LineStyle, CrosshairMode, type UTCTimestamp } from "lightweight-charts";
import { ChartFeedStatusBadge } from "@/components/charts/ChartFeedStatusBadge";
import { isLivePriceDisplay, type ChartDisplayStatus } from "@/lib/chart-display-status";
import { sanitizeCandlestickData } from "@/lib/chart-engine/candleSanitize";

// Mini chart preview for the Position-on-Chart side card.
// Renders recent OHLC + four horizontal price lines (entry/SL/TP/current)
// + a single entry marker (▲ for BUY, ▼ for SELL).
//
// SAFETY:
//  - View-only. No order placement surface. No fetches except for the
//    public candles endpoint passed in via props.
//  - Falls back to a clean "chart preview unavailable" message if candles
//    can't be loaded — never throws to break the page.
//  - HONEST FEED STATUS (Task #349): the candle feed's display status is
//    resolved identically to the Scanner (shared chart-display-status module).
//    When the feed is not genuinely LIVE, the live-price affordances — the
//    dashed "Current" price line and the candle series' last-value/price
//    line label — are suppressed, and an honest feed badge is shown.

export type Candle = { time: number; open: number; high: number; low: number; close: number };

export interface PositionMiniChartProps {
  symbol: string;
  side: "BUY" | "SELL";
  entryPrice: number;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  candles: Candle[];
  // Honest feed-status verdict for the candle feed (resolved by the parent from
  // the /api/chart/candles feedStatus contract). Defaults to ANALYSIS_ONLY so
  // an un-wired caller can never accidentally imply a live feed.
  displayStatus?: ChartDisplayStatus;
  height?: number;
}

export function PositionMiniChart({
  symbol, side, entryPrice, currentPrice, stopLoss, takeProfit, candles, displayStatus = "ANALYSIS_ONLY", height = 220,
}: PositionMiniChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isLive = isLivePriceDisplay(displayStatus);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.innerHTML = "";

    const chart = createChart(el, {
      width: el.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#a1a1aa",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "rgba(63, 63, 70, 0.3)" },
        horzLines: { color: "rgba(63, 63, 70, 0.3)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: "rgba(63, 63, 70, 0.5)" },
      rightPriceScale: { borderColor: "rgba(63, 63, 70, 0.5)" },
      handleScale: { mouseWheel: false, pinch: false, axisPressedMouseMove: false },
      handleScroll: { mouseWheel: false, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false },
    });

    // lightweight-charts v5: addSeries(CandlestickSeries, options). The legacy
    // v4 addCandlestickSeries() was removed and throws at runtime.
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981", downColor: "#ef4444",
      borderUpColor: "#10b981", borderDownColor: "#ef4444",
      wickUpColor: "#10b981", wickDownColor: "#ef4444",
      // Suppress the last-value / price-line label unless the feed is genuinely
      // live — a frozen or delayed feed must never imply a live tick.
      priceLineVisible: isLive,
      lastValueVisible: isLive,
    });

    // Drop malformed bars (missing / null / NaN OHLC) so the lightweight-charts
    // candlestick colorer can't throw "Value is null" during a later repaint.
    const sanitized = sanitizeCandlestickData(
      candles.map((c) => ({ time: Math.floor(c.time / 1000) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }))
    );
    if (sanitized.length > 0) {
      series.setData(sanitized);

      const addLine = (price: number, color: string, title: string, dashed = false) => {
        series.createPriceLine({
          price, color, lineWidth: 1,
          lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
          axisLabelVisible: true, title,
        });
      };
      addLine(entryPrice, "#3b82f6", `Entry · ${side === "BUY" ? "▲" : "▼"}`);
      // The dashed "Current" line is a live-price affordance — only draw it when
      // the candle feed is genuinely LIVE so a stale/delayed chart never shows a
      // moving "current" marker (Task #349).
      if (currentPrice != null && isLive) addLine(currentPrice, "#a1a1aa", "Current", true);
      if (stopLoss != null) addLine(stopLoss, "#ef4444", "SL");
      if (takeProfit != null) addLine(takeProfit, "#10b981", "TP");

      // Entry marker on the closest candle to entry time (use last candle as
      // anchor — the position is open right now so the marker stays visible).
      // lightweight-charts v5: markers moved off the series instance to the
      // standalone createSeriesMarkers(series, markers) plugin. Anchor to the
      // last SANITIZED bar (not raw candles[last]) so the marker time always
      // resolves to a bar that exists — an off-series marker time makes the
      // colorer's findBar() return null and throw "Value is null" on repaint.
      const lastT = sanitized[sanitized.length - 1]!.time as UTCTimestamp;
      createSeriesMarkers(series, [{
        time: lastT,
        position: side === "BUY" ? "belowBar" : "aboveBar",
        color: side === "BUY" ? "#10b981" : "#ef4444",
        shape: side === "BUY" ? "arrowUp" : "arrowDown",
        text: `${side} @ ${entryPrice}`,
      }]);

      chart.timeScale().fitContent();
    }

    // Teardown guard (mirrors ScannerChartPanel): a ResizeObserver callback
    // already queued before disconnect can still fire after chart.remove(), and
    // applyOptions on a removed chart throws "Object is disposed" (fancy-canvas
    // DevicePixelContentBoxBinding → resizeCanvas) straight into window.onerror —
    // uncatchable by React error boundaries, so it trips the dev runtime-error
    // overlay. This effect rebuilds on EVERY candle poll (deps below), so the
    // remove/observe churn makes the race easy to hit while a card sits open.
    let disposed = false;
    const ro = new ResizeObserver(() => {
      if (disposed) return;
      try {
        chart.applyOptions({ width: el.clientWidth });
      } catch { /* chart was removed mid-resize — nothing to size */ }
    });
    ro.observe(el);

    return () => {
      disposed = true;
      ro.disconnect();
      try { chart.remove(); } catch { /* already disposed */ }
    };
  }, [symbol, side, entryPrice, currentPrice, stopLoss, takeProfit, candles, height, isLive]);

  if (candles.length === 0) {
    return (
      <div
        data-testid="position-mini-chart-empty"
        className="rounded-md border border-border bg-background/50 p-4 text-center text-xs text-txt-muted"
        style={{ height }}
      >
        Chart preview unavailable for <span className="font-mono">{symbol}</span> right now.
      </div>
    );
  }

  return (
    <div className="relative w-full">
      <div
        ref={containerRef}
        data-testid="position-mini-chart"
        className="w-full overflow-hidden rounded-md border border-border bg-background/50"
        style={{ height }}
      />
      {/* Honest feed-status badge — only renders for non-LIVE states. */}
      <div className="pointer-events-none absolute left-2 top-2 z-10">
        <ChartFeedStatusBadge status={displayStatus} hasCandles={candles.length > 0} testIdPrefix="position-mini-chart" />
      </div>
    </div>
  );
}

export default PositionMiniChart;
