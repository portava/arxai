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

import { collectMarketStateFacts, type MarketStateFact } from "./stateClaims.js";
import { classifyMeasuredRank, type MeasuredRankInput } from "../../ranking/measuredRank.js";
export type EvidenceSource = "tool" | "user";

export interface EvidenceNumber {
  value: number;
  entities?: string[];
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
  /**
   * What KIND of calibrated number this is, when calibrated is true:
   *   "measured"  a measured probability that beat the base rate out of sample
   *   "base_rate" a measured base rate (the unconditional hit rate). It may be
   *               quoted as a base rate, never as this setup's edge.
   */
  calibrationKind: CalibrationKind | null;
  /** Graded outcomes (N) behind a calibration-stamp number, when known. */
  calibrationN: number | null;
}

export type CalibrationKind = "measured" | "base_rate";

export interface EvidenceTime {
  iso: string;
  utc: boolean;
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
  /** Instrument scope inherited from the enclosing execution object. */
  symbols: string[];
}

export interface EvidenceIndex {
  marketStates: MarketStateFact[];
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
  utcAllowed?: boolean;
  entities?: string[];
  entitySymbols?: string[];
  entityIds?: string[];
  stale: boolean | null;
  staleAsOf: string | null;
  calibrated: boolean | null;
  calibrationKind: CalibrationKind | null;
  calibrationN: number | null;
}

const ROOT_FRAME: Frame = { stale: null, staleAsOf: null, calibrated: null, calibrationKind: null, calibrationN: null };

// ── calibration stamps ──────────────────────────────────────────────────────
// The calibration engine (lib/calibration/cache.ts CalibrationStamp) does not
// write `calibrated: true`; it writes { probability, status, n, model,
// baseRate, edgeDetected, label, ... }. A stamp is recognised by its shape.
// Inside a stamp ONLY the probability / label / baseRate leaves are calibrated
// numbers; n, fitVersion etc. are counts, never probabilities. An unmeasured
// stamp marks everything under it uncalibrated.

interface StampInfo {
  measured: boolean;
  probability: number | null;
  /** Kind of the stamp's `probability` (and `label`) value. */
  kind: CalibrationKind;
  n: number;
}

export function calibrationStampInfo(obj: Record<string, unknown>): StampInfo | null {
  if (obj.status !== "measured" && obj.status !== "unmeasured") return null;
  if (!("probability" in obj) || typeof obj.n !== "number" || typeof obj.edgeDetected !== "boolean") return null;
  const rank = classifyMeasuredRank({ rawScore: 0, calibration: obj as unknown as MeasuredRankInput["calibration"] });
  const measured = rank.rankBasis !== "unmeasured_raw_order";
  return { measured, probability: measured ? obj.probability as number : null,
    kind: rank.rankBasis === "calibrated_probability" ? "measured" : "base_rate", n: rank.rankN };
}

function stampChildFrame(stamp: StampInfo, key: string, f: Frame): Frame {
  if (stamp.measured && key === "probability") return { ...f, calibrated: true, calibrationKind: stamp.kind, calibrationN: stamp.n };
  if (stamp.measured && key === "baseRate") return { ...f, calibrated: true, calibrationKind: "base_rate", calibrationN: stamp.n };
  return { ...f, calibrated: false, calibrationKind: null, calibrationN: null };
}

/** Payloads pair `calibratedProbability` with a sibling `calibration` stamp. */
const STAMP_SIBLING_KEYS = /^(calibratedProbability|calibratedProb|winProbability)$/;

function frameFor(obj: Record<string, unknown>, parent: Frame): Frame {
  const timeEvidence = obj.timeBasisEvidence as { kind?: unknown } | null | undefined;
  const utcAllowed = obj.observedTimeBasis === "source_clock" || obj.clockBasis === "broker_server"
    || (timeEvidence && timeEvidence.kind !== "original_utc") ? false : parent.utcAllowed;
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
  let calibrationKind = parent.calibrationKind;
  let calibrationN = parent.calibrationN;
  if (typeof obj.calibrated === "boolean") {
    // A boolean alone contains no model, sample count or validated probability.
    // Only the same measured stamp that Scanner accepts can support the claim.
    calibrated = false;
    calibrationKind = null;
    calibrationN = null;
  }
  const valuesFor = (keys: RegExp) => Object.entries(obj)
    .filter(([key, value]) => keys.test(key) && (typeof value === "string" || typeof value === "number"))
    .map(([, value]) => String(value).toLowerCase().replace(/[^a-z0-9]/g, ""));
  const ownSymbols = valuesFor(/^(symbol|displaySymbol|instrument|ticker|pair)$/);
  const ownIds = valuesFor(/^(ticket|id|actionId|mt5OrderTicket|mt5PositionTicket)$/);
  // A child with its own identity replaces that part of the ancestor scope.
  const entitySymbols = ownSymbols.length ? ownSymbols : parent.entitySymbols ?? [];
  const entityIds = ownIds.length ? ownIds : parent.entityIds ?? [];
  return { stale, staleAsOf, calibrated, calibrationKind, calibrationN, utcAllowed,
    entitySymbols, entityIds, entities: [...entitySymbols, ...entityIds] };

}

function addTimes(s: string, tool: string, out: EvidenceTime[], utcAllowed = true): void {
  for (const m of s.matchAll(ISO_TS)) {
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(m[0]);
    const d = new Date(m[0].replace(" ", "T") + (hasZone ? "" : "Z"));
    if (Number.isNaN(d.getTime())) continue;
    const iso = d.toISOString();
    out.push({ iso, date: iso.slice(0, 10), hhmm: iso.slice(11, 16), tool, utc: utcAllowed && hasZone });
    // The literal wall-clock in the string too (an offset timestamp may be quoted as written).
    if (`${m[2]}:${m[3]}` !== iso.slice(11, 16)) out.push({ iso: m[0], date: m[1], hhmm: `${m[2]}:${m[3]}`, tool, utc: false });
  }
}

function executionOf(obj: Record<string, unknown>, tool: string, path: string, frame: Frame): ExecutionEvidence | null {
  // A calibration stamp's status ("measured") is not an order status.
  if (calibrationStampInfo(obj)) return null;
  const status = typeof obj.status === "string" ? obj.status : null;
  const s = status?.toLowerCase() ?? "";
  const hasFill = obj.fillPrice != null && (obj.executedAt != null || obj.filledAt != null);
  const executed = EXECUTED_STATUSES.has(s) || obj.executed === true || obj.filled === true || (hasFill && !PARTIAL_STATUSES.has(s));
  const partial = PARTIAL_STATUSES.has(s);
  const looksLikeOrder = "actionId" in obj || "mt5OrderTicket" in obj || "mt5PositionTicket" in obj || "ticket" in obj || (hasFill && /execution|order|trade|fill/i.test(tool));
  if (!looksLikeOrder) return null;
  const t = obj.mt5PositionTicket ?? obj.mt5OrderTicket ?? obj.ticket ?? null;
  const ids = Object.entries(obj)
    .filter(([k, v]) => (typeof v === "number" || typeof v === "string") && /(^id$|Id$|ticket|Ticket)/.test(k))
    .map(([, v]) => String(v));
  return { tool, path, status, executed, partial, ticket: t == null ? null : String(t), ids, symbols: frame.entitySymbols ?? [] };
}

const SYMBOL_KEYS = /^(symbol|displaySymbol|instrument|market|name|ticker|pair)$/;

export function buildEvidenceIndex(outputs: ToolOutput[], userText = ""): EvidenceIndex {
  const idx: EvidenceIndex = { numbers: [], times: [], strings: [], executions: [], symbols: new Set(), toolNames: outputs.map((o) => o.name), marketStates: collectMarketStateFacts(outputs) };
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
      addTimes(v, tool, idx.times, frame.utcAllowed);
      // A numeric string field ("1.08523") is a typed value; a sentence carries text numbers.
      const asNum = /^-?\d+(?:\.\d+)?$/.test(v.trim()) ? Number(v.trim()) : null;
      if (asNum != null) idx.numbers.push({ value: asNum, key, keyTokens: splitKey(key), path, tool, source: "tool", fromText: false, ...frame });
      else for (const n of numbersInText(v.replace(ISO_TS, " "))) idx.numbers.push({ value: n, key, keyTokens: splitKey(key), path, tool, source: "tool", fromText: true, ...frame });
      return;
    }
    if (v instanceof Date) { if (Number.isFinite(v.getTime())) addTimes(v.toISOString(), tool, idx.times, frame.utcAllowed); return; }
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
    const exec = executionOf(obj, tool, path, f);
    if (exec) idx.executions.push(exec);
    const stamp = calibrationStampInfo(obj);
    const sibling = !stamp && obj.calibration && typeof obj.calibration === "object" ? calibrationStampInfo(obj.calibration as Record<string, unknown>) : null;
    for (const [k, child] of Object.entries(obj)) {
      const cf = stamp
        ? stampChildFrame(stamp, k, f)
        : sibling && STAMP_SIBLING_KEYS.test(k)
          ? stampChildFrame(sibling, child === sibling.probability ? "probability" : "unverified", f)
          : f;
      walk(child, k, path ? `${path}.${k}` : k, tool, cf, depth + 1);
    }
  };

  for (const o of outputs) walk(o.result, o.name, o.name, o.name, ROOT_FRAME, 0);

  if (userText) {
    for (const n of numbersInText(userText)) {
      idx.numbers.push({ value: n, key: "user", keyTokens: [], path: "user", tool: "user", source: "user", fromText: true, ...ROOT_FRAME });
    }
    addTimes(userText, "user", idx.times);
    idx.strings.push(userText.toLowerCase());
  }
  return idx;
}
