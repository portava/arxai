// Eleanor grounding — the evidence index.
//
// Everything Eleanor may state as fact in one answer must come from THIS turn's
// tool outputs (or be an echo of the user's own message). This module flattens
// those outputs into an index the claims checker can query: every numeric
// leaf, every number written inside a string leaf, every array length, every
// timestamp, together with the key path it came from and the nearest
// freshness / calibration flags above it.
//
// Pure and deterministic: no clock, no I/O.

export type EvidenceSource = "tool" | "user";

export interface EvidenceNumber {
  value: number;
  /** Lower-cased key tokens of the leaf, e.g. stopLoss -> ["stop", "loss"]. */
  keyTokens: string[];
  key: string;
  path: string;
  tool: string;
  source: EvidenceSource;
  /** The number was written inside a string (message/note), not a typed field. */
  fromText: boolean;
  /** Nearest ancestor (or self) object that carries a freshness verdict. */
  stale: boolean | null;
  staleAsOf: string | null;
  /** Nearest ancestor that says whether its numbers are calibrated probabilities. */
  calibrated: boolean | null;
}

export interface EvidenceTime {
  iso: string;
  date: string; // YYYY-MM-DD (UTC)
  hhmm: string; // HH:MM (UTC)
  tool: string;
}

export interface ExecutionEvidence {
  tool: string;
  path: string;
  status: string | null;
  executed: boolean;
  partial: boolean;
  ticket: string | null;
  /** Every id/ticket on the object (actionId, mt5 tickets, id, ...), as strings. */
  ids: string[];
}

export interface EvidenceIndex {
  numbers: EvidenceNumber[];
  times: EvidenceTime[];
  /** Every string leaf (lower-cased) — used for tickets and symbols. */
  strings: string[];
  executions: ExecutionEvidence[];
  /** Symbols/instrument names seen in evidence (so "V75" etc. are not claims). */
  symbols: Set<string>;
  toolNames: string[];
}

export interface ToolOutput {
  name: string;
  result: unknown;
}

/** Statuses that prove an order actually executed at the broker/paper venue. */
export const EXECUTED_STATUSES = new Set(["executed", "filled", "done", "complete", "completed", "closed_filled"]);
export const PARTIAL_STATUSES = new Set(["partially_filled", "partial", "partial_fill"]);

const STALE_FRESHNESS = /^(stale|delayed|unavailable|error|unknown|expired|offline|closed|no_data|none)$/i;
const FRESH_FRESHNESS = /^(realtime|real_time|live|fresh|current|ok)$/i;

export function splitKey(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

const NUM_IN_TEXT = /(?<![A-Za-z_\d.])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![A-Za-z_\d.])-?\d+(?:\.\d+)?/g;
const ISO_TS = /\b(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;

export function numbersInText(s: string): number[] {
  const out: number[] = [];
  for (const m of s.matchAll(NUM_IN_TEXT)) {
    const v = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

interface Frame {
  stale: boolean | null;
  staleAsOf: string | null;
  calibrated: boolean | null;
}

function frameFor(obj: Record<string, unknown>, parent: Frame): Frame {
  let stale = parent.stale;
  let staleAsOf = parent.staleAsOf;
  let own: boolean | null = null;
  if (typeof obj.stale === "boolean") own = obj.stale;
  else if (typeof obj.isStale === "boolean") own = obj.isStale;
  if (own !== true && typeof obj.freshness === "string") {
    if (STALE_FRESHNESS.test(obj.freshness)) own = true;
    else if (FRESH_FRESHNESS.test(obj.freshness) && own === null) own = false;
  }
  if (own !== true && obj.isLive === false && ("lastPrice" in obj || "price" in obj)) own = true;
  if (own !== null) {
    stale = own;
    const asOf = [obj.observedAt, obj.asOf, obj.lastCandleTime, obj.updatedAt, obj.timestamp]
      .find((v) => typeof v === "string") as string | undefined;
    staleAsOf = own ? asOf ?? null : null;
  }
  let calibrated = parent.calibrated;
  if (typeof obj.calibrated === "boolean") calibrated = obj.calibrated;
  return { stale, staleAsOf, calibrated };
}

function addTimes(s: string, tool: string, out: EvidenceTime[]): void {
  for (const m of s.matchAll(ISO_TS)) {
    const d = new Date(m[0].replace(" ", "T"));
    if (Number.isNaN(d.getTime())) {
      out.push({ iso: m[0], date: m[1], hhmm: `${m[2]}:${m[3]}`, tool });
      continue;
    }
    const iso = d.toISOString();
    out.push({ iso, date: iso.slice(0, 10), hhmm: iso.slice(11, 16), tool });
    // The literal wall-clock in the string too (an offset timestamp may be quoted as written).
    if (`${m[2]}:${m[3]}` !== iso.slice(11, 16)) out.push({ iso: m[0], date: m[1], hhmm: `${m[2]}:${m[3]}`, tool });
  }
}

function executionOf(obj: Record<string, unknown>, tool: string, path: string): ExecutionEvidence | null {
  const status = typeof obj.status === "string" ? obj.status : null;
  const s = status?.toLowerCase() ?? "";
  const hasFill = obj.fillPrice != null && (obj.executedAt != null || obj.filledAt != null);
  const executed = EXECUTED_STATUSES.has(s) || obj.executed === true || obj.filled === true || (hasFill && !PARTIAL_STATUSES.has(s));
  const partial = PARTIAL_STATUSES.has(s);
  const looksLikeOrder = status != null || "fillPrice" in obj || "executed" in obj || "mt5OrderTicket" in obj || "ticket" in obj;
  if (!looksLikeOrder) return null;
  const t = obj.mt5PositionTicket ?? obj.mt5OrderTicket ?? obj.ticket ?? null;
  const ids = Object.entries(obj)
    .filter(([k, v]) => (typeof v === "number" || typeof v === "string") && /(^id$|Id$|ticket|Ticket)/.test(k))
    .map(([, v]) => String(v));
  return { tool, path, status, executed, partial, ticket: t == null ? null : String(t), ids };
}

const SYMBOL_KEYS = /^(symbol|displaySymbol|instrument|market|name|ticker|pair)$/;

export function buildEvidenceIndex(outputs: ToolOutput[], userText = ""): EvidenceIndex {
  const idx: EvidenceIndex = { numbers: [], times: [], strings: [], executions: [], symbols: new Set(), toolNames: outputs.map((o) => o.name) };
  const seen = new WeakSet<object>();

  const walk = (v: unknown, key: string, path: string, tool: string, frame: Frame, depth: number): void => {
    if (depth > 12) return;
    if (typeof v === "number") {
      if (Number.isFinite(v)) idx.numbers.push({ value: v, key, keyTokens: splitKey(key), path, tool, source: "tool", fromText: false, ...frame });
      return;
    }
    if (typeof v === "string") {
      const lower = v.toLowerCase();
      idx.strings.push(lower);
      if (SYMBOL_KEYS.test(key)) idx.symbols.add(lower);
      addTimes(v, tool, idx.times);
      // A numeric string field ("1.08523") is a typed value; a sentence carries text numbers.
      const asNum = /^-?\d+(?:\.\d+)?$/.test(v.trim()) ? Number(v.trim()) : null;
      if (asNum != null) idx.numbers.push({ value: asNum, key, keyTokens: splitKey(key), path, tool, source: "tool", fromText: false, ...frame });
      else for (const n of numbersInText(v.replace(ISO_TS, " "))) idx.numbers.push({ value: n, key, keyTokens: splitKey(key), path, tool, source: "tool", fromText: true, ...frame });
      return;
    }
    if (v instanceof Date) { addTimes(v.toISOString(), tool, idx.times); return; }
    if (!v || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      idx.numbers.push({ value: v.length, key: `${key}.length`, keyTokens: [...splitKey(key), "count"], path: `${path}.length`, tool, source: "tool", fromText: false, ...frame });
      v.forEach((item, i) => walk(item, key, `${path}[${i}]`, tool, frame, depth + 1));
      return;
    }
    const obj = v as Record<string, unknown>;
    const f = frameFor(obj, frame);
    const exec = executionOf(obj, tool, path);
    if (exec) idx.executions.push(exec);
    for (const [k, child] of Object.entries(obj)) walk(child, k, path ? `${path}.${k}` : k, tool, f, depth + 1);
  };

  for (const o of outputs) walk(o.result, o.name, o.name, o.name, { stale: null, staleAsOf: null, calibrated: null }, 0);

  if (userText) {
    for (const n of numbersInText(userText)) {
      idx.numbers.push({ value: n, key: "user", keyTokens: [], path: "user", tool: "user", source: "user", fromText: true, stale: null, staleAsOf: null, calibrated: null });
    }
    addTimes(userText, "user", idx.times);
    idx.strings.push(userText.toLowerCase());
  }
  return idx;
}
