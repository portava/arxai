import type { ChartStudy, StudyKind } from "./chartStudies";
export type ChartStyle = "candles" | "bars" | "line";
export type DrawingKind = "horizontal" | "trend" | "fibonacci";
export interface ChartAnchor { time: number; price: number }
export interface ChartDrawing { id: string; kind: DrawingKind; start: ChartAnchor; end?: ChartAnchor; color: string }
export interface ChartPreferences { style: ChartStyle; scale: "linear" | "log"; studies: ChartStudy[] }
export const DEFAULT_PREFERENCES: ChartPreferences = { style: "candles", scale: "linear", studies: [] };
export const MAX_DRAWINGS = 40;
const color = (v: unknown): v is string => typeof v === "string" && /^#[a-f\d]{6}$/i.test(v);
const period = (v: unknown): v is number => Number.isInteger(v) && Number(v) >= 2 && Number(v) <= 200;
const anchor = (v: any): v is ChartAnchor => v && Number.isFinite(v.time) && v.time > 0 && v.time < 1e11 && Number.isFinite(v.price) && v.price > 0;
export function validatePreferences(value: unknown): ChartPreferences {
  const v = value as any;
  if (!v || typeof v !== "object") return { ...DEFAULT_PREFERENCES, studies: [] };
  const seen = new Set<StudyKind>();
  const studies: ChartStudy[] = [];
  for (const s of Array.isArray(v.studies) ? v.studies.slice(0, 5) : []) {
    if (!s || !["sma", "ema", "bollinger", "rsi", "macd"].includes(s.kind) || seen.has(s.kind) || !period(s.period) || !color(s.color)) continue;
    if (s.kind === "bollinger" && (!Number.isFinite(s.multiplier) || s.multiplier < .5 || s.multiplier > 5)) continue;
    if (s.kind === "macd" && (!period(s.slow) || s.slow <= s.period || !period(s.signal))) continue;
    seen.add(s.kind);
    studies.push({ kind: s.kind, period: s.period, color: s.color, ...(s.kind === "bollinger" ? {multiplier:s.multiplier} : {}), ...(s.kind === "macd" ? {slow:s.slow,signal:s.signal} : {}) });
  }
  return { style: ["candles", "bars", "line"].includes(v.style) ? v.style : "candles", scale: v.scale === "log" ? "log" : "linear", studies };
}
export function validateDrawings(value: unknown): ChartDrawing[] {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value.slice(0, MAX_DRAWINGS) : []).flatMap((d: any) => {
    if (!d || typeof d.id !== "string" || d.id.length > 80 || seen.has(d.id) || !["horizontal", "trend", "fibonacci"].includes(d.kind) || !anchor(d.start) || !color(d.color)) return [];
    if (d.kind !== "horizontal" && (!anchor(d.end) || d.end.time === d.start.time)) return [];
    seen.add(d.id);
    return [{ id:d.id, kind:d.kind, start:{time:d.start.time,price:d.start.price}, ...(d.kind !== "horizontal" ? {end:{time:d.end.time,price:d.end.price}} : {}), color:d.color }];
  });
}
/** Local device preferences only. No account, positions, credentials or feed
 * data are stored. Separate symbol/timeframe keys prevent cross-chart leakage. */
export function drawingStorageKey(symbol: string, timeframe: string): string { return `arx.chart.drawings.v1:${encodeURIComponent(symbol)}:${encodeURIComponent(timeframe)}`; }
export function readChartStorage(key: string): unknown {
  try { const raw = localStorage.getItem(key); return raw && raw.length < 100_000 ? JSON.parse(raw) : null; } catch { return null; }
}
export function writeChartStorage(key: string, value: unknown): boolean {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
export const PREFERENCES_KEY = "arx.chart.preferences.v1";
export const TEMPLATE_KEY = "arx.chart.template.v1";
export const FIB_LEVELS = [0, .236, .382, .5, .618, .786, 1];
export function drawingSegments(d: ChartDrawing) {
  if (!d.end) return [];
  if (d.kind === "trend") return [{ start:d.start, end:d.end, label:"Trend" }];
  return FIB_LEVELS.map(level => {
    const price = d.start.price + (d.end!.price - d.start.price) * level;
    return { start:{time:d.start.time,price}, end:{time:d.end!.time,price}, label:`Fib ${(level * 100).toFixed(1)}%` };
  });
}
