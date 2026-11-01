import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChartFeedStatusBadge } from "@/components/charts/ChartFeedStatusBadge";
import { ChartEngineCredit } from "@/components/charts/ChartLibraryCredit";
import { createChartEngineAdapter, type ChartEngineAdapter, type ChartEngineId } from "@/lib/chart-engine";
import { isLivePriceDisplay, type ChartDisplayStatus } from "@/lib/chart-display-status";
import { sanitizeCandlestickData } from "@/lib/chart-engine/candleSanitize";

/** Read-only position preview. Candles are supplied in epoch milliseconds;
 * neither a source clock authority nor an entry timestamp is supplied here.
 * Entry/SL/TP are price references, never invented historical event markers. */
export type Candle = { time: number; open: number; high: number; low: number; close: number };
export interface PositionMiniChartProps {
  symbol: string;
  side: "BUY" | "SELL";
  entryPrice: number;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  candles: Candle[];
  displayStatus?: ChartDisplayStatus;
  height?: number;
}

export function PositionMiniChart({
  symbol, side, entryPrice, currentPrice, stopLoss, takeProfit, candles, displayStatus = "ANALYSIS_ONLY", height = 220,
}: PositionMiniChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const adapterRef = useRef<ChartEngineAdapter | null>(null);
  const contextRef = useRef<string | null>(null);
  const [engineId, setEngineId] = useState<ChartEngineId>();
  const [renderFailed, setRenderFailed] = useState(false);
  const [paintVerified, setPaintVerified] = useState(true);
  const sanitized = useMemo(() => sanitizeCandlestickData(candles.map(c => ({
    time: Math.floor(c.time / 1000), open: c.open, high: c.high, low: c.low, close: c.close,
  }))), [candles]);
  const hasCandles = sanitized.length > 0;
  const isLive = isLivePriceDisplay(displayStatus);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !hasCandles) return;
    let engine: ChartEngineAdapter | null = null;
    let disposed = false;
    let observer: ResizeObserver | null = null;
    let unsubscribePaint: (() => void) | undefined;
    setRenderFailed(false);
    try {
      engine = createChartEngineAdapter();
      engine.init({ container: el, height });
      adapterRef.current = engine;
      contextRef.current = null;
      setEngineId(engine.capabilities.id);
      const current = engine;
      const readPaintProof = () => {
        if (disposed || adapterRef.current !== current) return;
        setPaintVerified(current.isAnalysisFocusVerified?.() !== false);
      };
      unsubscribePaint = current.subscribeViewport?.(readPaintProof);
      readPaintProof();
      observer = new ResizeObserver(() => {
        if (disposed || adapterRef.current !== engine) return;
        try { engine?.resize(el.clientWidth); } catch { /* a disposed renderer must not break the page */ }
      });
      observer.observe(el);
    } catch {
      try { engine?.destroy(); } catch { /* preserve the unavailable fallback */ }
      engine = null;
      adapterRef.current = null;
      setEngineId(undefined);
      setRenderFailed(true);
    }
    return () => {
      disposed = true;
      unsubscribePaint?.();
      observer?.disconnect();
      if (adapterRef.current === engine) adapterRef.current = null;
      contextRef.current = null;
      try { engine?.destroy(); } catch { /* teardown is idempotent */ }
    };
    // A valid preview retains its renderer across data/money/size updates.
    // Height is initialized here and updated by the separate resize effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasCandles]);

  useLayoutEffect(() => {
    const engine = adapterRef.current;
    if (!engine || !hasCandles || renderFailed) return;
    try {
      if (contextRef.current !== symbol) {
        engine.resetDataContext?.();
        engine.setSymbol?.(symbol);
        // A timestamp alone is not evidence of UTC clock qualification.
        engine.setSourceClockQualified?.(false);
        contextRef.current = symbol;
      }
      // Keep the same shared live-display verdict as the original preview.
      // No source identity is available in this component's candle contract.
      engine.setFeedState({ livePriceAffordance: isLive, source: null });
      engine.setCandles(sanitized);
      engine.fitHistory?.();
    } catch { setRenderFailed(true); }
  }, [symbol, sanitized, hasCandles, isLive, renderFailed]);

  useLayoutEffect(() => {
    const engine = adapterRef.current;
    if (!engine || !hasCandles || renderFailed) return;
    const surface = engine.getScannerOverlaySurface?.();
    if (!surface) { setRenderFailed(true); return; }
    try {
      const addLine = (price: number | null, color: string, title: string, dashed = false) => {
        if (price == null || !Number.isFinite(price) || price <= 0) return;
        surface.createPriceLine({ price, color, title, lineWidth: 1, lineStyle: dashed ? "dashed" : "solid", axisLabelVisible: true });
      };
      addLine(entryPrice, "#3b82f6", `Entry · ${side}`);
      if (isLive) addLine(currentPrice, "#a1a1aa", "Current", true);
      addLine(stopLoss, "#ef4444", "SL");
      addLine(takeProfit, "#10b981", "TP");
      // No marker: the caller supplies no actual entry time.
    } catch { setRenderFailed(true); }
    return () => surface.dispose();
  }, [symbol, sanitized, hasCandles, side, entryPrice, currentPrice, stopLoss, takeProfit, isLive, renderFailed]);

  useLayoutEffect(() => {
    if (!hasCandles || renderFailed) return;
    try { adapterRef.current?.resize(undefined, height); } catch { setRenderFailed(true); }
  }, [height, hasCandles, renderFailed]);

  const available = hasCandles && !renderFailed;
  return <div className="relative w-full">
    {!available && <div data-testid="position-mini-chart-empty" className="rounded-md border border-zinc-800 bg-zinc-950/50 p-4 text-center text-xs text-zinc-500" style={{ height }}>
      Chart preview unavailable for <span className="font-mono">{symbol}</span> right now.
    </div>}
    <div hidden={!available} role="img" aria-label={`${symbol} position price preview. Read-only supplied candles with entry, stop-loss and take-profit price references when available. Entry time and source clock are unverified.`}>
      {/* Inert removes renderer keyboard/gesture interaction. Pointer events
          pass to the surrounding scrolling page, not a chart navigation owner. */}
      <div ref={containerRef} inert aria-hidden="true" data-testid="position-mini-chart" className="pointer-events-none w-full overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/50" style={{ height }} />
    </div>
    {available && <>
      <div className="pointer-events-none absolute left-2 top-2 z-10"><ChartFeedStatusBadge status={displayStatus} hasCandles testIdPrefix="position-mini-chart" /></div>
      {!paintVerified && <p role="status" data-testid="position-mini-chart-paint-status" className="px-2 py-1 text-xs text-amber-200">Chart preview is not yet verified. Wait for it to finish drawing; if this persists, reopen the preview.</p>}
      <ChartEngineCredit engineId={engineId} />
    </>}
  </div>;
}
export default PositionMiniChart;
