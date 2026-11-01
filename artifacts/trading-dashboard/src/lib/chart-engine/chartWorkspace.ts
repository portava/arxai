import { chartIntervalSeconds } from "./chartIntervals";
import { MAX_STUDIES, STUDY_CATALOG, studyId, type ChartStudy, type StudyLineStyle } from "./chartStudies";
import { isChartTimeZone, type ChartTimeZone } from "./chartTimeZone";
import { normalizeNoteText } from "./chartTextNote";
export type ChartScaleMode = "linear" | "log" | "percent" | "indexed";
/** Display styles in picker order. The first three keep their original order
 * so existing keyboard steps (candles <-> bars) measure the same thing. */
export const CHART_STYLES = ["candles", "bars", "line", "area", "baseline", "heikinAshi", "hollow"] as const;
export type ChartStyle = typeof CHART_STYLES[number];
export const CHART_STYLE_NAMES: Record<ChartStyle, string> = { candles: "Candlesticks", bars: "OHLC bars", line: "Close line", area: "Close area", baseline: "Close baseline", heikinAshi: "Heikin Ashi", hollow: "Hollow candles" };
/** Styles that plot only canonical closes. */
export function closeOnlyStyle(style: ChartStyle): style is "line" | "area" | "baseline" { return style === "line" || style === "area" || style === "baseline"; }
const STYLE_NOTES: Record<ChartStyle, string> = {
  candles: "",
  bars: "",
  line: "The line shows closes; candle patterns also use open, high and low prices.",
  area: "The area shows closes; candle patterns also use open, high and low prices.",
  baseline: "The baseline shows closes against the first loaded close; candle patterns also use open, high and low prices.",
  heikinAshi: "Heikin Ashi bodies are averaged, not traded prices; readings, pattern anchors, drawings and trade levels use the underlying candles.",
  hollow: "Hollow candle fill and colour are display encodings of the same OHLC: fill compares close with open, colour compares close with the previous close.",
};
/** Reader text for a style: display name plus what the style does and does not show. */
export function describeChartStyle(style: ChartStyle): { name: string; note: string } {
  const known: ChartStyle = (CHART_STYLES as readonly string[]).includes(style) ? style : "candles";
  return { name: CHART_STYLE_NAMES[known], note: STYLE_NOTES[known] };
}
export type DrawingKind = "horizontal" | "vertical" | "trend" | "ray" | "extended" | "rectangle" | "fibonacci" | "text" | "channel" | "measure";
export const DRAWING_NAMES: Record<DrawingKind, string> = { measure: "Price and time ruler", channel: "Parallel channel", horizontal: "Horizontal level", vertical: "Vertical line", trend: "Trend line", ray: "Ray", extended: "Extended line", rectangle: "Rectangle", fibonacci: "Fibonacci retracement", text: "Text note (yours)" };
export function singleAnchorDrawing(kind: DrawingKind): boolean { return kind === "horizontal" || kind === "vertical" || kind === "text"; }
export interface ChartAnchor { time: number; price: number }
export interface FibonacciOrigin { method:"confirmed-swings-v1"; span:2; symbol:string; timeframe:string; source:string; sourceIdentity:string; start:ChartAnchor; end:ChartAnchor; confirmedAt:number; windowFrom:number; windowTo:number; closedBars:number }
export interface ChartDrawing { fibonacciOrigin?:FibonacciOrigin; id: string; kind: DrawingKind; start: ChartAnchor; end?: ChartAnchor; offset?: ChartAnchor; color: string; locked?: boolean; hidden?: boolean; width?: 1 | 2 | 3; dashed?: boolean; text?: string; extendLeft?: boolean; extendRight?: boolean; middleLine?: boolean }
/**
 * Per chart view (each workspace view has its own stored preferences).
 * `timeZone` is display-only and optional: a missing value means UTC, and it is
 * never saved in or applied by a template. Daily timeframes (D1/W1/MN1) always
 * display UTC. Stored anchors, links and data requests stay Unix UTC seconds.
 */
export interface ChartPreferences { style: ChartStyle; scale: ChartScaleMode; inverted?: boolean; priceOnlyScale?: boolean; studies: ChartStudy[]; timeZone?: ChartTimeZone }
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
    if (s.kind === "tick_volume" && s.period !== 1) continue;
    if (s.id != null && (typeof s.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(s.id))) continue;
    const id = studyId(s);
    if (seen.has(id)) continue;
    if (s.source != null && !sources.includes(s.source)) continue;
    if (s.signalMethod != null && !["sma", "ema"].includes(s.signalMethod)) continue;
    if (s.method != null && !["sma", "ema", "smma", "wma"].includes(s.method)) continue;
    if (["bollinger", "envelopes"].includes(s.kind) && (!Number.isFinite(s.multiplier) || s.multiplier <= 0 || s.multiplier > 100)) continue;
    if (s.kind === "macd" && (!period(s.slow) || s.slow <= s.period || !period(s.signal))) continue;
    if (s.kind === "dmi" && !period(s.signal)) continue;
    if (s.kind === "stochastic" && (!period(s.smoothing) || !period(s.signal))) continue;
    let lineStyles: StudyLineStyle[] | undefined;
    if (s.lineStyles != null) {
      const channels = STUDY_CATALOG.find(item=>item.defaults.kind === s.kind)!.channels.length;
      if (!Array.isArray(s.lineStyles) || s.lineStyles.length > channels) continue;
      let invalid = false;
      lineStyles = Array.from(s.lineStyles, (style: any, index) => {
        if (!style || typeof style !== "object" || Array.isArray(style)
          || (style.color != null && !color(style.color))
          || (style.width != null && ![1,2,3].includes(style.width))
          || (style.style != null && !["solid","dashed","dotted"].includes(style.style))
          || (style.visible != null && typeof style.visible !== "boolean")
          || (s.kind === "macd" && index === 2 && [style.color,style.width,style.style].some(v=>v != null))) { invalid=true; return {}; }
        return {...(style.color != null ? {color:style.color} : {}),...(style.width != null ? {width:style.width} : {}),...(style.style != null ? {style:style.style} : {}),...(style.visible != null ? {visible:style.visible} : {})};
      });
      if (invalid) continue;
    }
    seen.add(id);
    studies.push({
      ...(lineStyles?.length ? {lineStyles} : {}),
      ...(s.id ? { id: s.id } : {}), kind: s.kind, period: s.period, color: s.color,
      ...(s.source ? { source: s.source } : {}),
      ...(["bollinger", "envelopes"].includes(s.kind) ? { multiplier: s.multiplier } : {}),
      ...(s.kind === "macd" ? { slow: s.slow, signal: s.signal, ...(s.signalMethod ? { signalMethod: s.signalMethod } : {}) } : {}),
      ...(s.kind === "dmi" ? {signal:s.signal} : {}),
      ...(s.kind === "stochastic" ? { smoothing: s.smoothing, signal: s.signal } : {}),
      ...(["atr", "envelopes"].includes(s.kind) && s.method ? { method: s.method } : {}),
    });
  }
  return { style: (CHART_STYLES as readonly unknown[]).includes(v.style) ? v.style : "candles", scale: ["linear", "log", "percent", "indexed"].includes(v.scale) ? v.scale : "linear", ...(v.inverted === true ? {inverted:true} : {}), ...(v.priceOnlyScale === true ? {priceOnlyScale:true} : {}), studies, ...(isChartTimeZone(v.timeZone) && v.timeZone !== "UTC" ? {timeZone:v.timeZone} : {}) };
}
function validateFibonacciOrigin(value: unknown): FibonacciOrigin | null {
  const p=value as Partial<FibonacciOrigin>|null;
  const interval=chartIntervalSeconds(p?.timeframe);
  if(!p||!interval||p.method!=="confirmed-swings-v1"||p.span!==2||![p.symbol,p.timeframe,p.source].every(v=>typeof v==="string"&&v.length>0&&v.length<=120)
    ||typeof p.sourceIdentity!=="string"||!/^[a-f\d]{64}$/i.test(p.sourceIdentity)||!anchor(p.start)||!anchor(p.end)||p.start.time>=p.end.time||p.start.price===p.end.price
    ||![p.confirmedAt,p.windowFrom,p.windowTo].every(value=>typeof value==="number"&&Number.isFinite(value)&&value>0&&value<1e11)||p.start.time-p.windowFrom!<2*interval||p.end.time-p.start.time<interval||p.confirmedAt!-p.end.time<3*interval||p.windowTo!<p.confirmedAt!
    ||!Number.isInteger(p.closedBars)||p.closedBars!<6||p.closedBars!>600)return null;
  return {method:"confirmed-swings-v1",span:2,symbol:p.symbol!,timeframe:p.timeframe!,source:p.source!,sourceIdentity:p.sourceIdentity,start:{...p.start!},end:{...p.end!},confirmedAt:p.confirmedAt!,windowFrom:p.windowFrom!,windowTo:p.windowTo!,closedBars:p.closedBars!};
}
export function validateDrawings(value: unknown): ChartDrawing[] {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value.slice(0, MAX_DRAWINGS) : []).flatMap((d: any) => {
    if (!d || typeof d.id !== "string" || d.id.length > 80 || seen.has(d.id) || !Object.hasOwn(DRAWING_NAMES, d.kind) || !anchor(d.start) || !color(d.color)) return [];
    if (!singleAnchorDrawing(d.kind) && (!anchor(d.end) || (d.kind !== "measure" && d.end.time === d.start.time))) return [];
    if (d.kind === "channel" && !anchor(d.offset)) return [];
    if (d.kind === "channel" && [d.extendLeft,d.extendRight,d.middleLine].some(v=>v != null && typeof v !== "boolean")) return [];
    const text = d.kind === "text" ? normalizeNoteText(d.text) : null;
    if (d.kind === "text" && text == null) return [];
    if (d.width != null && ![1, 2, 3].includes(d.width)) return [];
    if (d.hidden != null && typeof d.hidden !== "boolean") return [];
    if (d.locked != null && typeof d.locked !== "boolean" || d.dashed != null && typeof d.dashed !== "boolean") return [];
    const fibonacciOrigin=d.kind==="fibonacci"?validateFibonacciOrigin(d.fibonacciOrigin):null;
    seen.add(d.id);
    return [{ ...(fibonacciOrigin?{fibonacciOrigin}:{}),id:d.id, kind:d.kind, start:{time:d.start.time,price:d.start.price}, ...(!singleAnchorDrawing(d.kind) ? {end:{time:d.end.time,price:d.end.price}} : {}), ...(d.kind === "channel" ? {offset:{time:d.offset.time,price:d.offset.price},...(d.extendLeft === true ? {extendLeft:true} : {}),...(d.extendRight === true ? {extendRight:true} : {}),...(d.middleLine === true ? {middleLine:true} : {})} : {}), color:d.color, ...(d.hidden === true ? {hidden:true} : {}), ...(d.locked != null ? {locked:d.locked} : {}), ...(d.width != null ? {width:d.width} : {}), ...(d.dashed != null ? {dashed:d.dashed} : {}), ...(text != null ? {text} : {}) }];
  });
}
/** Local device preferences only. No account, positions or credentials are stored. Kept auto drawings retain their original source hash
 * and anchor summary, not full candle history. Separate symbol/timeframe keys
 * prevent cross-chart leakage. */
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
