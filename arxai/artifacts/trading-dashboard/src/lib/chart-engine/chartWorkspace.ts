import { MAX_STUDIES, STUDY_CATALOG, studyId, type ChartStudy } from "./chartStudies";
export type ChartScaleMode = "linear" | "log" | "percent" | "indexed";
export type ChartStyle = "candles" | "bars" | "line";
export type DrawingKind = "horizontal" | "vertical" | "trend" | "ray" | "extended" | "rectangle" | "fibonacci";
export const DRAWING_NAMES: Record<DrawingKind, string> = { horizontal: "Horizontal level", vertical: "Vertical line", trend: "Trend line", ray: "Ray", extended: "Extended line", rectangle: "Rectangle", fibonacci: "Fibonacci retracement" };
export function singleAnchorDrawing(kind: DrawingKind): boolean { return kind === "horizontal" || kind === "vertical"; }
export interface ChartAnchor { time: number; price: number }
export interface ChartDrawing { id: string; kind: DrawingKind; start: ChartAnchor; end?: ChartAnchor; color: string; locked?: boolean; width?: 1 | 2 | 3; dashed?: boolean }
export interface ChartPreferences { style: ChartStyle; scale: ChartScaleMode; inverted?: boolean; studies: ChartStudy[] }
export const DEFAULT_PREFERENCES: ChartPreferences = { style: "candles", scale: "linear", studies: [] };
export const MAX_DRAWINGS = 40;
const color = (v: unknown): v is string => typeof v === "string" && /^#[a-f\d]{6}$/i.test(v);
const period = (v: unknown): v is number => Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 1000;
const anchor = (v: any): v is ChartAnchor => v && Number.isFinite(v.time) && v.time > 0 && v.time < 1e11 && Number.isFinite(v.price) && v.price > 0;
export function validatePreferences(value: unknown): ChartPreferences {
  const v = value as any;
  if (!v || typeof v !== "object") return { ...DEFAULT_PREFERENCES, studies: [] };
  const seen = new Set<string>();
  const studies: ChartStudy[] = [];
  const kinds = new Set(STUDY_CATALOG.map(item => item.defaults.kind));
  const sources = ["close", "open", "high", "low", "hl2", "hlc3", "hlcc4", "ohlc4"];
  for (const s of Array.isArray(v.studies) ? v.studies.slice(0, MAX_STUDIES) : []) {
    if (!s || !kinds.has(s.kind) || !period(s.period) || !color(s.color)) continue;
    if (s.id != null && (typeof s.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(s.id))) continue;
    const id = studyId(s);
    if (seen.has(id)) continue;
    if (s.source != null && !sources.includes(s.source)) continue;
    if (s.signalMethod != null && !["sma", "ema"].includes(s.signalMethod)) continue;
    if (s.method != null && !["sma", "ema", "smma", "wma"].includes(s.method)) continue;
    if (["bollinger", "envelopes"].includes(s.kind) && (!Number.isFinite(s.multiplier) || s.multiplier <= 0 || s.multiplier > 100)) continue;
    if (s.kind === "macd" && (!period(s.slow) || s.slow <= s.period || !period(s.signal))) continue;
    if (s.kind === "stochastic" && (!period(s.smoothing) || !period(s.signal))) continue;
    seen.add(id);
    studies.push({
      ...(s.id ? { id: s.id } : {}), kind: s.kind, period: s.period, color: s.color,
      ...(s.source ? { source: s.source } : {}),
      ...(["bollinger", "envelopes"].includes(s.kind) ? { multiplier: s.multiplier } : {}),
      ...(s.kind === "macd" ? { slow: s.slow, signal: s.signal, ...(s.signalMethod ? { signalMethod: s.signalMethod } : {}) } : {}),
      ...(s.kind === "stochastic" ? { smoothing: s.smoothing, signal: s.signal } : {}),
      ...(["atr", "envelopes"].includes(s.kind) && s.method ? { method: s.method } : {}),
    });
  }
  return { style: ["candles", "bars", "line"].includes(v.style) ? v.style : "candles", scale: ["linear", "log", "percent", "indexed"].includes(v.scale) ? v.scale : "linear", ...(v.inverted === true ? {inverted:true} : {}), studies };
}
export function validateDrawings(value: unknown): ChartDrawing[] {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value.slice(0, MAX_DRAWINGS) : []).flatMap((d: any) => {
    if (!d || typeof d.id !== "string" || d.id.length > 80 || seen.has(d.id) || !Object.hasOwn(DRAWING_NAMES, d.kind) || !anchor(d.start) || !color(d.color)) return [];
    if (!singleAnchorDrawing(d.kind) && (!anchor(d.end) || d.end.time === d.start.time)) return [];
    if (d.width != null && ![1, 2, 3].includes(d.width)) return [];
    if (d.locked != null && typeof d.locked !== "boolean" || d.dashed != null && typeof d.dashed !== "boolean") return [];
    seen.add(d.id);
    return [{ id:d.id, kind:d.kind, start:{time:d.start.time,price:d.start.price}, ...(!singleAnchorDrawing(d.kind) ? {end:{time:d.end.time,price:d.end.price}} : {}), color:d.color, ...(d.locked != null ? {locked:d.locked} : {}), ...(d.width != null ? {width:d.width} : {}), ...(d.dashed != null ? {dashed:d.dashed} : {}) }];
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
  if (["trend", "ray", "extended"].includes(d.kind)) return [{ start:d.start, end:d.end, label:"Trend" }];
  if (d.kind === "rectangle") return [
    {start:d.start, end:{time:d.end.time,price:d.start.price}, label:""},
    {start:{time:d.end.time,price:d.start.price}, end:d.end, label:""},
    {start:d.end, end:{time:d.start.time,price:d.end.price}, label:""},
    {start:{time:d.start.time,price:d.end.price}, end:d.start, label:""},
  ];
  if (d.kind !== "fibonacci") return [];
  return FIB_LEVELS.map(level => {
    const price = d.start.price + (d.end!.price - d.start.price) * level;
    return { start:{time:d.start.time,price}, end:{time:d.end!.time,price}, label:`Fib ${(level * 100).toFixed(1)}%` };
  });
}
