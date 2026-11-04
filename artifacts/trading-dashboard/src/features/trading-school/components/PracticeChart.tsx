/**
 * PracticeChart — a tiny inline-SVG candle chart for Trading School labs.
 * Draws static practice OHLC arrays (never live data) with optional
 * highlights, an SMA overlay, horizontal levels and a lower oscillator pane.
 * Interactive labs draw their own layers through `overlay`, which receives the
 * chart geometry so they can map prices <-> SVG y.
 */
import { forwardRef, useEffect, useRef, useState, type ReactNode, type CSSProperties, type PointerEventHandler } from "react";
import type { Candle, LowerPane } from "../data/labs";
import { sma } from "../lib/labMath";

/** fallback drawing width when the container cannot be measured (SSR / jsdom) */
export const CHART_W = 600;
/** width reserved on the right for price labels / drag handles */
export const AXIS_W = 64;
const PAD_T = 22;
const PAD_B = 10;
const PANE_H = 80;
const PANE_GAP = 14;

export interface ChartGeom {
  width: number;
  height: number;
  plotW: number;
  top: number;
  bottom: number;
  min: number;
  max: number;
  y: (price: number) => number;
  price: (y: number) => number;
  x: (index: number) => number;
  slot: number;
}

export function makeGeom(count: number, min: number, max: number, height: number, paneH = 0, width = CHART_W): ChartGeom {
  const plotW = width - AXIS_W;
  const top = PAD_T;
  const bottom = height - PAD_B - paneH;
  const span = max - min || 1;
  const slot = plotW / Math.max(1, count);
  return {
    width, height, plotW, top, bottom, min, max, slot,
    y: (p) => top + ((max - p) / span) * (bottom - top),
    price: (yy) => max - ((yy - top) / (bottom - top)) * span,
    x: (i) => slot * i + slot / 2,
  };
}

export function priceRange(candles: ReadonlyArray<Candle>, padFrac = 0.08): { min: number; max: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) { lo = Math.min(lo, c[2]); hi = Math.max(hi, c[1]); }
  const pad = (hi - lo) * padFrac || 1;
  return { min: lo - pad, max: hi + pad };
}

export interface PracticeChartProps {
  candles: ReadonlyArray<Candle>;
  height?: number;
  min?: number;
  max?: number;
  digits?: number;
  highlight?: number[];
  smaPeriod?: number;
  levels?: { price: number; label: string }[];
  lowerPane?: LowerPane;
  overlay?: (g: ChartGeom) => ReactNode;
  ariaLabel: string;
  className?: string;
  style?: CSSProperties;
  onPointerMove?: PointerEventHandler<SVGSVGElement>;
  onPointerUp?: PointerEventHandler<SVGSVGElement>;
  onPointerDown?: PointerEventHandler<SVGSVGElement>;
}

const UP = "var(--color-success)";
const DOWN = "var(--color-danger)";
const GRID = "var(--color-border)";
const MUTED = "var(--color-txt-muted)";
const ACCENT = "var(--color-primary)";

export const PracticeChart = forwardRef<SVGSVGElement, PracticeChartProps>(function PracticeChart(
  { candles, height = 240, min, max, digits = 2, highlight, smaPeriod, levels, lowerPane, overlay, ariaLabel, className, style, onPointerMove, onPointerUp, onPointerDown },
  ref,
) {
  // Draw at the container's real pixel width so text and hit areas keep
  // their size on a 375px phone instead of being scaled down.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(CHART_W);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => { const w = Math.round(el.clientWidth); if (w > 0) setWidth(Math.max(240, w)); };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const range = priceRange(candles);
  const paneH = lowerPane ? PANE_H + PANE_GAP : 0;
  const g = makeGeom(candles.length, min ?? range.min, max ?? range.max, height, paneH, width);
  const bodyW = Math.max(4, Math.min(26, g.slot * 0.62));
  const ticks = 4;
  const tickPrices = Array.from({ length: ticks + 1 }, (_, i) => g.min + ((g.max - g.min) * i) / ticks);
  const smaVals = smaPeriod ? sma(candles.map((c) => c[3]), smaPeriod) : null;
  const smaPath = smaVals
    ? smaVals.reduce((d, v, i) => (v === null ? d : `${d}${d ? " L" : "M"}${g.x(i).toFixed(1)},${g.y(v).toFixed(1)}`), "")
    : "";

  // lower pane geometry
  const paneTop = g.bottom + PANE_GAP;
  const paneBottom = paneTop + PANE_H;
  const py = (v: number) => lowerPane ? paneTop + ((lowerPane.max - v) / (lowerPane.max - lowerPane.min || 1)) * (paneBottom - paneTop) : 0;

  return (
    <div ref={wrapRef} className="w-full min-w-0">
    <svg
      ref={ref}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel}
      className={className ?? "block h-auto w-full select-none"}
      style={style}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerDown={onPointerDown}
      onPointerCancel={onPointerUp}
    >
      {/* grid + price axis */}
      {tickPrices.map((p, i) => (
        <g key={i}>
          <line x1={0} x2={g.plotW} y1={g.y(p)} y2={g.y(p)} stroke={GRID} strokeWidth={1} strokeDasharray="2 4" />
          <text x={g.plotW + 6} y={g.y(p) + 4} fontSize={11} fill={MUTED}>{p.toFixed(digits)}</text>
        </g>
      ))}
      <text x={4} y={14} fontSize={12} fill={MUTED}>Practice data · not live prices</text>

      {/* highlights */}
      {highlight?.map((i) => (
        <rect key={`h${i}`} x={g.x(i) - g.slot / 2 + 1} y={g.top - 6} width={g.slot - 2} height={g.bottom - g.top + 12}
          fill={ACCENT} opacity={0.12} rx={4} />
      ))}

      {/* levels */}
      {levels?.map((l) => (
        <g key={l.label}>
          <line x1={0} x2={g.plotW} y1={g.y(l.price)} y2={g.y(l.price)} stroke="var(--color-warning)" strokeWidth={1.5} strokeDasharray="6 4" />
          <text x={4} y={g.y(l.price) - 4} fontSize={12} fill="var(--color-warning)">{l.label}</text>
        </g>
      ))}

      {/* candles */}
      {candles.map((c, i) => {
        const [o, h, l, cl] = c;
        const up = cl >= o;
        const color = up ? UP : DOWN;
        const yTop = g.y(Math.max(o, cl));
        const yBot = g.y(Math.min(o, cl));
        return (
          <g key={i} data-candle={i}>
            <line x1={g.x(i)} x2={g.x(i)} y1={g.y(h)} y2={g.y(l)} stroke={color} strokeWidth={1.6} />
            <rect x={g.x(i) - bodyW / 2} y={yTop} width={bodyW} height={Math.max(1.5, yBot - yTop)} fill={color} rx={1} />
          </g>
        );
      })}

      {smaPath && (
        <path d={smaPath} fill="none" stroke={ACCENT} strokeWidth={2} strokeDasharray="6 4" data-testid="sma-line" />
      )}

      {lowerPane && (
        <g data-testid="lower-pane">
          <rect x={0} y={paneTop} width={g.plotW} height={PANE_H} fill="none" stroke={GRID} />
          {lowerPane.levels?.map((lv) => (
            <g key={lv}>
              <line x1={0} x2={g.plotW} y1={py(lv)} y2={py(lv)} stroke={GRID} strokeDasharray="3 3" />
              <text x={g.plotW + 6} y={py(lv) + 4} fontSize={12} fill={MUTED}>{lv}</text>
            </g>
          ))}
          <polyline
            points={lowerPane.values.map((v, i) => `${g.x(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ")}
            fill="none" stroke={ACCENT} strokeWidth={2} />
          <text x={4} y={paneTop + 14} fontSize={12} fill={MUTED}>{lowerPane.label}</text>
        </g>
      )}

      {overlay?.(g)}
    </svg>
    </div>
  );
});
