// Eleanor grounding: the claims checker.
//
// It extracts every checkable claim from an answer: numbers (prices, P&L,
// sizes, counts, percentages, durations), ticket/order ids, clock times and
// dates, "it executed" statements, "this is live" statements and probability
// statements. Each one must be grounded in THIS turn's tool outputs (see
// evidence.ts). An echo of a number the user wrote is also allowed. The checker
// reports these finding kinds:
//
//   FABRICATION               no tool output supports the number/ticket/time
//   WRONG_NUMBER              a labelled figure ("stop loss 1.0820") disagrees
//                             with the tool field of that name
//   STALE_AS_LIVE             a price from stale data presented as live/current
//   UNCALIBRATED_PROBABILITY  a score or unsupported figure presented as a
//                             probability/chance, a 0-100 score as a percent,
//                             or a measured base rate presented as an edge.
//                             Calibrated = a measured calibration stamp
//                             (status "measured", numeric probability) or a
//                             legacy `calibrated: true` field (evidence.ts)
//   EXECUTION_UNCONFIRMED     "filled/executed/placed" claimed with no executed
//                             result in the evidence
//
// The checker is pure, deterministic and runs in microseconds, so the same code
// grades the eval corpus in CI and verifies production answers at runtime
// (runtimeVerifier.ts).

import { buildEvidenceIndex, splitKey, type EvidenceIndex, type EvidenceNumber, type ToolOutput } from "./evidence.js";

export type ClaimKind = "number" | "ticket" | "time" | "date" | "execution";
export type FindingKind = "FABRICATION" | "WRONG_NUMBER" | "STALE_AS_LIVE" | "UNCALIBRATED_PROBABILITY" | "EXECUTION_UNCONFIRMED";
export const FINDING_KINDS: readonly FindingKind[] = ["FABRICATION", "WRONG_NUMBER", "STALE_AS_LIVE", "UNCALIBRATED_PROBABILITY", "EXECUTION_UNCONFIRMED"];

export interface Claim {
  kind: ClaimKind;
  text: string;
  /** Offsets inside the whole checked text. */
  start: number;
  end: number;
  value?: number;
  grounded: boolean;
  /** Paths of the evidence that grounds it (first few). */
  groundedBy: string[];
}

export interface Finding {
  kind: FindingKind;
  claim: Claim;
  detail: string;
  /** For WRONG_NUMBER: the tool values the label points at. */
  expected?: number[];
}

export interface Segment {
  text: string;
  start: number;
  end: number;
}

export interface CheckResult {
  claims: Claim[];
  findings: Finding[];
  segments: Array<Segment & { findings: Finding[]; claims: Claim[] }>;
  grounded: boolean;
}

// ── segmentation ─────────────────────────────────────────────────────────────
/**
 * Split into sentence-like segments: a newline ends a segment; ". ", "! ", "? "
 * end one (a decimal point never does, it is not followed by whitespace).
 * Offsets are preserved so the verifier can rewrite in place.
 */
export function splitSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    const endsHere = c === "\n" || ((c === "." || c === "!" || c === "?") && (next === " " || next === "\n" || next === undefined) && !isAbbrev(text, i));
    if (endsHere) {
      out.push({ text: text.slice(start, i + 1), start, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < text.length) out.push({ text: text.slice(start), start, end: text.length });
  return out;
}

export function isAbbrev(text: string, dot: number): boolean {
  if (text[dot] !== ".") return false;
  // "1." / "12." at the start of a line is a list marker, not a sentence end.
  const lineStart = text.lastIndexOf("\n", dot - 1) + 1;
  if (/^\s*\d{1,3}$/.test(text.slice(lineStart, dot))) return true;
  const before = text.slice(Math.max(0, dot - 5), dot + 1).toLowerCase();
  return /(?:\be\.g|\bi\.e|\bvs|\betc|\bapprox|\bno)\.$/.test(before);
}

// ── masking: things that look like numbers but are not claims ───────────────
const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const MONTH_INDEX: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const INSTRUMENT_RE = /\b(?:volatility|vol|crash|boom|jump|step|range break|dex(?:up|down)?|drift switch|bear market|bull market)(?:\s+index)?\s+\d+(?:\s*\(1s\))?(?:\s+index)?/gi;
// Mixed letter+digit tokens: V75, US30, R_100, 1HZ100V, H1, M15, 4h, 2nd. Kept
// as claims: 10k / 2bn / 50pips / 250ms (amount or unit suffixes).
const MIXED_TOKEN_RE = /\b(?=[\w]*[A-Za-z])(?=[\w]*\d)[\w]+\b/g;
const UNIT_SUFFIX_OK = /^\d+(?:\.\d+)?(?:k|bn|pips?|ms)$/i;
const LIST_MARKER_RE = /^(\s*)(\d+)([.)])(?=\s)/gm;
// A bullet dash is not a minus sign ("- 405000 is the target").
const BULLET_RE = /^(\s*)[-*•−](?=\s)/gm;
const ORDINAL_WORD_RE = /\b(?:option|step|rule|tier|phase|part|section|item|slice|pr|issue|chapter|page)\s+#?\d+\b/gi;
const DENOMINATOR_RE = /(\d)\s*\/\s*(10|100|5)\b/g;
const RATIO_LEFT_RE = /\b1\s*:\s*(?=\d)/g;
// The "1" of "2:1" / "3 : 1" (a reward-to-risk ratio), never a clock minute.
const RATIO_RIGHT_RE = /(?<=\b\d+(?:\.\d+)?\s*:\s*)1(?![\d.:])/g;
// A list size the model offers ("rescan for the top 5 setups"), not a fact.
const TOP_N_RE = /\b(?:top|best)\s+\d+\b/gi;
// A phrasing the model suggests the user type ("send something like “action
// #123”", "like **#123**", "say “check action 42”") is an example, not a claim.
// Segment-local so the streaming verifier and speech gate judge it the same.
const EXAMPLE_CUE = String.raw`(?:like|such as|e\.g\.?,?|for example,?|for instance,?|say|send|try|type|reply with|ask(?: me)?)`;
const EXAMPLE_QUOTED_RE = new RegExp(String.raw`\b${EXAMPLE_CUE}\s*:?\s*(?:\*\*)?(?:[“"][^”"\n]{1,200}[”"]|\`[^\`\n]{1,200}\`)`, "gi");
const EXAMPLE_ID_RE = new RegExp(String.raw`\b${EXAMPLE_CUE}\s*(?:\*\*)?#\d+(?:\*\*)?`, "gi");
// A bullet whose whole content is one quotation is a suggested phrasing.
const QUOTED_BULLET_RE = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(?:\*\*)?[“"][^”"\n]{1,200}[”"](?:\*\*)?[.,;]?\s*$/;

function mask(s: string, re: RegExp, keep?: (m: RegExpExecArray) => boolean): string {
  return s.replace(re, (...args) => {
    const m = args[0] as string;
    const groups = args.slice(1, -2);
    const offset = args[args.length - 2] as number;
    const fakeExec = Object.assign([m, ...groups], { index: offset, input: s }) as unknown as RegExpExecArray;
    if (keep && keep(fakeExec)) return m;
    return " ".repeat(m.length);
  });
}

// ── extraction ───────────────────────────────────────────────────────────────
const TICKET_RE = /#\s?(\d{3,})\b|\b(?:ticket|order|position|deal|action|command)\s*(?:id|no\.?|number|#)?\s*(?:is|was|=)?\s*:?\s*#?(\d{3,})\b/gi;
const TIME_RE = /\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?(?:\s?(UTC|GMT|Z)\b)?/g;
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS})\\b|\\b(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi");
const NUMBER_RE = /(?<![\w.])([-−+]?)\s?([$€£])?\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?(k|K|bn)(?![A-Za-z]))?(\s?%)?/g;
const UNIT_AFTER_RE = /^\s*(ms|milliseconds?|s\b|secs?|seconds?|mins?|minutes?|h\b|hrs?|hours?|days?|d\b|pips?|points?|pts)\b/i;

function unitMs(u: string): number | null {
  const x = u.toLowerCase();
  if (x.startsWith("ms") || x.startsWith("milli")) return 1;
  if (x === "s" || x.startsWith("sec")) return 1000;
  if (x.startsWith("min")) return 60_000;
  if (x === "h" || x.startsWith("hr") || x.startsWith("hour")) return 3_600_000;
  if (x === "d" || x.startsWith("day")) return 86_400_000;
  return null;
}

// ── labels ───────────────────────────────────────────────────────────────────
const GENERIC_TOKENS = new Set([
  "price", "value", "amount", "total", "count", "current", "last", "latest", "id", "at", "time", "ms", "the", "a", "an", "is", "of", "was",
  "my", "your", "its", "num", "number", "level", "raw", "usd", "basis", "this", "that", "now", "per", "for", "to", "in", "on", "and",
  "today", "data", "result", "results", "summary", "status", "user", "tool", "list", "item", "items", "rows", "row", "new", "open",
]);
const SYNONYMS: Array<[RegExp, string[]]> = [
  [/^sl$/, ["stop", "loss"]], [/^tp$/, ["take", "profit"]], [/^stop$/, ["stop"]],
  [/^p&l$|^p\/l$|^pnl$|^profit\/loss$/, ["pnl"]], [/^lots?$/, ["lot"]], [/^pips?$/, ["pip"]],
  [/^fill(?:ed)?$/, ["fill"]], [/^target$/, ["take", "profit"]], [/^entry$|^entered$/, ["entry"]], [/^realised$/, ["realized"]], [/^unrealised$/, ["unrealized"]],
  [/^today'?s$/, ["todays"]], [/^positions?$/, ["positions"]], [/^trades?$/, ["trades"]], [/^tickets?$/, ["ticket"]],
];
const DERIVED_WORDS = /\b(?:out of|distance|away|risk(?:ing)?|from|between|change|difference|move|moved|gap|above|below|up|down|range|average|avg|about|roughly|approximately|around|total of)\b/i;

function normalizeLabelWord(w: string): string[] {
  const x = w.toLowerCase().replace(/[^a-z&/']/g, "");
  if (!x) return [];
  for (const [re, out] of SYNONYMS) if (re.test(x)) return out;
  return [x.replace(/'s$/, "").replace(/'/g, "")];
}

function labelTokensBefore(segText: string, localStart: number): { tokens: Set<string>; derived: boolean; denominator?: boolean } {
  let pre = segText.slice(0, localStart);
  const cut = Math.max(pre.lastIndexOf(","), pre.lastIndexOf(";"), pre.lastIndexOf(":"), pre.lastIndexOf("("), pre.lastIndexOf("\n"), pre.lastIndexOf(" and "), pre.lastIndexOf(" with "), pre.lastIndexOf(" vs "));
  if (cut >= 0) pre = pre.slice(cut + 1);
  // "2 of 5" / "2 out of 5": the second number is a capacity, not the first's field.
  if (/\d\s+(?:out\s+)?of\s*$/i.test(pre)) return { tokens: new Set(), derived: true, denominator: true };
  // Stop at a previous number: its label is not ours.
  const lastNum = pre.search(/\d[^\d]*$/);
  if (lastNum >= 0) pre = pre.slice(lastNum + 1);
  const words = pre.split(/\s+/).filter(Boolean).slice(-4);
  const tokens = new Set<string>();
  for (const w of words) for (const t of normalizeLabelWord(w)) tokens.add(t);
  return { tokens, derived: DERIVED_WORDS.test(words.join(" ")) };
}

function labelTokensAfter(segText: string, localEnd: number, maxWords = 3): { tokens: Set<string>; derived: boolean } {
  let post = segText.slice(localEnd);
  const cut = post.search(/[,;:.()\n]|\d|\s(?:and|with|but|vs|while|or|then|so)\s/);
  if (cut >= 0) post = post.slice(0, cut);
  const words = post.split(/\s+/).filter(Boolean).slice(0, maxWords);
  const tokens = new Set<string>();
  for (const w of words) for (const t of normalizeLabelWord(w)) tokens.add(t);
  return { tokens, derived: DERIVED_WORDS.test(words.join(" ")) };
}

/** A field's key tokens through the same synonyms as label words (tp → take profit). */
function specificTokens(e: EvidenceNumber): string[] {
  const out = new Set<string>();
  for (const k of e.keyTokens) for (const t of normalizeLabelWord(k)) if (!GENERIC_TOKENS.has(t)) out.add(t === "realised" ? "realized" : t);
  return [...out];
}

/** How many of the field's specific tokens the label names: all of them, or 0. */
function labelStrength(e: EvidenceNumber, tokens: Set<string>): number {
  if (e.source !== "tool" || e.fromText) return 0;
  const spec = specificTokens(e);
  return spec.length > 0 && spec.every((t) => tokens.has(t)) ? spec.length : 0;
}

// ── grounding ────────────────────────────────────────────────────────────────
interface NumClaim {
  value: number; // signed value as written (after k/bn scaling)
  decimals: number;
  scale: number;
  percent: boolean;
  unitMs: number | null;
  pips: boolean;
}

function tolerance(decimals: number, scale: number): number {
  return 0.5 * Math.pow(10, -decimals) * scale + 1e-9;
}

function matchesValue(c: NumClaim, e: EvidenceNumber): boolean {
  const ev = e.value;
  const tol = tolerance(c.decimals, c.scale);
  if (Math.abs(ev - c.value) <= tol) return true;
  if (c.percent && Math.abs(ev * 100 - c.value) <= tol) return true;
  // Pips/points are a price distance in instrument units; the pip size depends
  // on the symbol, so accept the standard decimal shifts of a price distance.
  if (c.pips && [10, 100, 1000, 10_000, 100_000].some((k) => Math.abs(ev * k - c.value) <= tol)) return true;
  if (c.unitMs != null) {
    const evMs = e.keyTokens.includes("ms") ? ev : e.keyTokens.some((t) => /^sec(onds?)?$/.test(t)) ? ev * 1000 : e.keyTokens.some((t) => /^min(utes?)?$/.test(t)) ? ev * 60_000 : null;
    if (evMs != null && Math.abs(evMs / c.unitMs - c.value) < 1) return true;
  }
  return false;
}

const SCORE_TOKENS = new Set(["score", "quality", "confidence", "strength", "grade", "conviction", "rank", "rating", "cohesion"]);
const PERCENT_TOKENS = new Set(["pct", "percent", "percentage", "rate", "ratio", "utilization", "probability", "share", "pct100"]);
const PROBABILITY_WORDS = /\b(?:probabilit(?:y|ies)|prob\b|chance|chances|odds|likel(?:y|ihood)|confidence|confident|certain(?:ty)?|sure)\b/i;
const PROBABILITY_DISCLAIMED = /\b(?:not (?:a )?(?:calibrated )?probabilit(?:y|ies)|isn't a probability|not calibrated|uncalibrated|no calibrated)\b/i;
// A measured BASE RATE (calibration stamp with no out-of-sample edge) may be
// quoted only as a base rate / historical hit rate, never as this setup's edge.
const BASE_RATE_FRAMED = /\b(?:base[- ]rate|historical(?:ly)?|overall|on average|across (?:all|every)|of (?:all|these|those|past|similar) (?:calls|signals|setups|trades)|hit rate|win rate|unconditional)\b/i;
const EDGE_CLAIMED = /\b(?:edge|beats?|beating|outperform(?:s|ing)?|better than (?:the )?(?:base|average|random)|above (?:the )?base|this (?:setup|signal|call|trade) (?:has|is|wins|works))\b/i;
const EDGE_DENIED = /\b(?:no|not|without|isn't|zero|never)\s+(?:an?\s+|any\s+|the\s+)?(?:\w+\s+)?edge\b/i;
const LIVE_WORDS = /\b(?:live(?!\s+(?:account|trading|mode|trades?|book|positions?|execution|orders?|bridge|venue|money|capital|lane|switch))|real[- ]?time|right now|currently|current price|current quote|at the moment|as of now|trading at|trades at|is at|latest tick|spot)\b/i;
const STALE_DISCLOSED = /\b(?:stale|delayed|not live|isn't live|not a live|not current|not a current|last (?:recorded|known|close|closing)|as of|old|outdated|unconfirmed|out of date|frozen|closed market|market is closed)\b/i;
const EXECUTION_AFFIRM = /\b(?:executed|filled|got filled|went through|placed|I(?:'ve| have)? (?:opened|bought|sold|entered|closed))\b/i;
const EXECUTION_CONTEXT = /\b(?:order|trade|position|buy|sell|long|short|entry|ticket|lots?|I)\b/i;
const EXECUTION_NEGATED = /\b(?:nothing|none|neither|nor|not|never|no|cannot|can't|won't|wouldn't|unable|without|until|unless|if|once|when|would|could|should|will|can|may|might|pending|awaiting|preview|draft|haven't|hasn't|wasn't|isn't|didn't|failed|rejected|cancel(?:led|ed)?|expired|yet|whether|need|needs|ready)\b|n't\b|'ll\b/i;

/** Explicit identities, including FX pairs absent from this turn's evidence. */
function namedSymbols(text: string, idx: EvidenceIndex): string[] {
  const normal = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const found: Array<{ value: string; at: number }> = [];
  for (const symbol of idx.symbols) {
    const value = normal(symbol);
    if (value.length < 3) continue;
    const pattern = value.split("").join("[ /_-]*");
    for (const match of text.matchAll(new RegExp(`(?<![a-z0-9])${pattern}(?![a-z0-9])`, "gi"))) {
      found.push({ value, at: match.index! });
    }
  }
  const currency = "USD|EUR|GBP|JPY|CHF|AUD|NZD|CAD|XAU|XAG|BTC|ETH";
  for (const match of text.matchAll(new RegExp(`\\b(?:${currency})[ /_-]?(?:${currency})\\b`, "gi"))) {
    found.push({ value: normal(match[0]), at: match.index! });
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map(hit => hit.value))];
}

/** Commas between digits are thousands separators, not clause boundaries. */
function numericClause(text: string, start: number, end: number): { before: string; after: string } {
  const before = text.slice(0, start).split(/[,;]\s+|\b(?:and|but|while|whereas)\b/i).at(-1)!;
  const after = text.slice(end).split(/[,;]\s+|\b(?:and|but|while|whereas)\b/i)[0]!;
  return { before, after };
}

export function checkClaims(answer: string, outputs: ToolOutput[], userText = ""): CheckResult {
  return checkWithIndex(answer, buildEvidenceIndex(outputs, userText));
}

export function checkWithIndex(answer: string, idx: EvidenceIndex): CheckResult {
  const segments = splitSegments(answer).map((seg) => ({ ...seg, ...checkSegment(seg, idx) }));
  const claims = segments.flatMap((s) => s.claims);
  const findings = segments.flatMap((s) => s.findings);
  return { claims, findings, segments, grounded: findings.length === 0 };
}

export function checkSegment(seg: Segment, idx: EvidenceIndex): { claims: Claim[]; findings: Finding[] } {
  const claims: Claim[] = [];
  const findings: Finding[] = [];
  const raw = seg.text;
  let work = raw;

  // Instrument names, mixed tokens, list markers, ordinal words, denominators, ratio "1:".
  for (const sym of idx.symbols) {
    if (sym.length < 2 || !/\d/.test(sym)) continue;
    const re = new RegExp(sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    work = mask(work, re);
  }
  work = mask(work, INSTRUMENT_RE);
  work = mask(work, MIXED_TOKEN_RE, (m) => UNIT_SUFFIX_OK.test(m[0]));
  work = work.replace(LIST_MARKER_RE, (m, sp: string, d: string, p: string) => sp + " ".repeat(d.length) + p);
  work = work.replace(BULLET_RE, (m, sp: string) => sp + " ");
  work = mask(work, ORDINAL_WORD_RE);
  work = work.replace(DENOMINATOR_RE, (m, d: string) => d + " ".repeat(m.length - 1));
  work = mask(work, RATIO_LEFT_RE);
  work = mask(work, RATIO_RIGHT_RE);
  work = mask(work, TOP_N_RE);
  work = mask(work, EXAMPLE_QUOTED_RE);
  work = mask(work, EXAMPLE_ID_RE);
  if (QUOTED_BULLET_RE.test(raw)) work = " ".repeat(work.length);

  const pushClaim = (c: Omit<Claim, "start" | "end"> & { localStart: number; localEnd: number }): Claim => {
    const claim: Claim = { kind: c.kind, text: c.text, start: seg.start + c.localStart, end: seg.start + c.localEnd, value: c.value, grounded: c.grounded, groundedBy: c.groundedBy };
    claims.push(claim);
    return claim;
  };

  // Tickets.
  for (const m of work.matchAll(TICKET_RE)) {
    const id = m[1] ?? m[2];
    const n = Number(id);
    const hit = idx.numbers.find((e) => e.value === n) ?? null;
    const inStrings = !hit && idx.strings.some((s) => new RegExp(`(?<!\\d)${id}(?!\\d)`).test(s));
    const localStart = (m.index ?? 0) + m[0].indexOf(id);
    const claim = pushClaim({ kind: "ticket", text: id, value: n, grounded: !!hit || inStrings, groundedBy: hit ? [hit.path] : inStrings ? ["text"] : [], localStart, localEnd: localStart + id.length });
    if (!claim.grounded) findings.push({ kind: "FABRICATION", claim, detail: `ticket/id ${id} does not appear in any tool output this turn` });
    work = work.slice(0, localStart) + " ".repeat(id.length) + work.slice(localStart + id.length);
  }

  // Dates.
  for (const m of work.matchAll(ISO_DATE_RE)) {
    const d = `${m[1]}-${m[2]}-${m[3]}`;
    const ok = idx.times.some((t) => t.date === d);
    const claim = pushClaim({ kind: "date", text: d, grounded: ok, groundedBy: ok ? ["time"] : [], localStart: m.index ?? 0, localEnd: (m.index ?? 0) + m[0].length });
    if (!ok) findings.push({ kind: "FABRICATION", claim, detail: `date ${d} is not in any tool output this turn` });
  }
  work = mask(work, ISO_DATE_RE);
  for (const m of work.matchAll(DAY_MONTH_RE)) {
    const day = Number(m[1] ?? m[4]);
    const mon = MONTH_INDEX[(m[2] ?? m[3]).slice(0, 3).toLowerCase()];
    const ok = idx.times.some((t) => Number(t.date.slice(5, 7)) === mon && Number(t.date.slice(8, 10)) === day);
    const claim = pushClaim({ kind: "date", text: m[0], grounded: ok, groundedBy: ok ? ["time"] : [], localStart: m.index ?? 0, localEnd: (m.index ?? 0) + m[0].length });
    if (!ok) findings.push({ kind: "FABRICATION", claim, detail: `date "${m[0]}" is not in any tool output this turn` });
  }
  work = mask(work, DAY_MONTH_RE);

  // Clock times.
  for (const m of work.matchAll(TIME_RE)) {
    const hhmm = `${m[1].padStart(2, "0")}:${m[2]}`;
    const ok = idx.times.some((t) => t.hhmm === hhmm);
    const claim = pushClaim({ kind: "time", text: m[0], grounded: ok, groundedBy: ok ? ["time"] : [], localStart: m.index ?? 0, localEnd: (m.index ?? 0) + m[0].length });
    if (!ok) findings.push({ kind: "FABRICATION", claim, detail: `time ${hhmm} (UTC) is not in any tool output this turn` });
  }
  work = mask(work, TIME_RE);

  // Numbers.
  const probabilityContext = PROBABILITY_WORDS.test(raw) && !PROBABILITY_DISCLAIMED.test(raw);
  const liveContext = LIVE_WORDS.test(raw) && !STALE_DISCLOSED.test(raw);
  for (const m of work.matchAll(NUMBER_RE)) {
    const localStart = (m.index ?? 0) + (m[0].length - m[0].trimStart().length);
    const localEnd = (m.index ?? 0) + m[0].length;
    const digits = m[3].replace(/,/g, "");
    const frac = m[4] ?? "";
    const suffix = (m[5] ?? "").toLowerCase();
    const percent = !!m[6];
    const scale = suffix === "k" ? 1000 : suffix === "bn" ? 1e9 : 1;
    const value = Number(digits + frac) * scale;
    if (!Number.isFinite(value)) continue;
    const rest = raw.slice(localEnd);
    const unit = UNIT_AFTER_RE.exec(rest)?.[1] ?? null;
    const nc: NumClaim = {
      value: (m[1] === "-" || m[1] === "−" ? -1 : 1) * value, decimals: frac ? frac.length - 1 : 0, scale, percent,
      unitMs: unit ? unitMs(unit) : null,
      pips: !!unit && /^(pips?|points?|pts)$/i.test(unit),
    };
    // Bind within the local clause in either grammatical order. A value-first
    // statement must not borrow a different instrument's otherwise valid price.
    const clause = numericClause(raw, localStart, localEnd);
    const prefixSymbols = namedSymbols(clause.before, idx);
    const symbol = prefixSymbols.at(-1) ?? namedSymbols(clause.after, idx)[0]
      ?? namedSymbols(raw.slice(0, localStart), idx).at(-1);
    const ticketPattern = /(?:#|(?:ticket|position|order|action)\s*(?:#|id)?\s*)(\d{3,})/gi;
    const ticket = [...clause.before.matchAll(ticketPattern)].at(-1)?.[1]
      ?? [...clause.after.matchAll(ticketPattern)][0]?.[1];
    const entityMatches = (e: EvidenceNumber) => (!symbol || !!e.entities?.includes(symbol)) && (!ticket || !!e.entities?.includes(ticket));
    const candidates = idx.numbers.filter(e => e.source === "user" ? /you (?:asked|said|provided|requested|mentioned)|your (?:requested|specified)|^\s*(?:Risking|If you risk)\b/i.test(raw) : entityMatches(e));
    const matches = candidates.filter((e) => matchesValue(nc, e));
    const claim = pushClaim({
      kind: "number", text: raw.slice(localStart, localEnd).trim(), value: (m[1] === "-" || m[1] === "−" ? -1 : 1) * value,
      grounded: matches.length > 0, groundedBy: matches.slice(0, 3).map((e) => e.path), localStart, localEnd,
    });

    // Probability: a percent (or a 0..1 figure) stated as a chance/probability.
    const calibratedMatches = matches.filter((e) => e.calibrated === true);
    if (probabilityContext && (percent || (value > 0 && value < 1))) {
      if (calibratedMatches.length === 0) {
        findings.push({ kind: "UNCALIBRATED_PROBABILITY", claim, detail: `"${claim.text}" is presented as a probability/chance but no tool output marks it as a calibrated probability` });
        continue;
      }
    }
    // A measured base rate (no out-of-sample edge) is quotable only AS a base
    // rate: framed as one, and never as this setup's edge.
    if ((percent || (value > 0 && value < 1)) && calibratedMatches.length > 0 && !calibratedMatches.some((e) => e.calibrationKind === "measured")) {
      const asProbability = probabilityContext && !BASE_RATE_FRAMED.test(raw);
      // An edge claim is fine only when the SAME stamp measured an edge.
      const edgeProven = calibratedMatches.some((b) => {
        const stampPath = b.path.replace(/\.[^.]+$/, "");
        return idx.numbers.some((e) => e.calibrationKind === "measured" && e.path.startsWith(`${stampPath}.`));
      });
      const edgeClaimed = EDGE_CLAIMED.test(raw) && !EDGE_DENIED.test(raw);
      if (asProbability || (edgeClaimed && !edgeProven)) {
        findings.push({ kind: "UNCALIBRATED_PROBABILITY", claim, detail: `"${claim.text}" is a measured base rate (${calibratedMatches[0].path}, no edge over the base rate detected) presented as this setup's probability/edge` });
        continue;
      }
    }
    // A 0-100 score shown as a percentage.
    if (percent && matches.length > 0) {
      const tokensOf = (e: EvidenceNumber) => e.keyTokens;
      const asScore = matches.filter((e) => tokensOf(e).some((t) => SCORE_TOKENS.has(t)));
      const asPct = matches.filter((e) => e.source === "user" || tokensOf(e).some((t) => PERCENT_TOKENS.has(t)) || (e.fromText && /%/.test(raw)));
      if (asScore.length > 0 && asPct.length === 0 && !matches.some((e) => e.calibrated === true)) {
        findings.push({ kind: "UNCALIBRATED_PROBABILITY", claim, detail: `"${claim.text}" shows a score (${asScore[0].path}) as a percentage; scores are not calibrated probabilities` });
        continue;
      }
    }

    // Labelled figure that disagrees with the field of that name.
    const before = labelTokensBefore(raw, localStart);
    // What follows labels it too ("3 open positions", "0.1 lots").
    // A decimal takes only the word right after it as a label (its unit),
    // unless the sentence names it: "3.65 is the profit target".
    const namesIt = /^\s+(?:is|was)\s/i.test(raw.slice(localEnd));
    const after = !percent && scale === 1 ? labelTokensAfter(raw, localEnd, frac && !namesIt ? 1 : 4) : null;
    const labelSets = [before, ...(after ? [after] : [])].filter((l) => !l.derived && l.tokens.size > 0);
    const tokens = new Set(labelSets.flatMap((l) => [...l.tokens]));
    // The label points at the MOST specific fields it fully names: "take profit"
    // is the tp field, not the shorter "profit"; "filled size ... lots" is
    // filledLotSize, not fillPrice.
    let labelled: EvidenceNumber[] = [];
    if (!nc.pips && nc.unitMs == null && !before.denominator && tokens.size > 0) {
      const strength = candidates.map((e) => labelStrength(e, tokens));
      const best = Math.max(0, ...strength);
      if (best > 0) labelled = candidates.filter((_, i) => strength[i] === best);
    }
    {
      if (labelled.length > 0 && !labelled.some((e) => matchesValue(nc, e))) {
        findings.push({
          kind: "WRONG_NUMBER", claim,
          detail: `"${claim.text}" is labelled ${[...tokens].join(" ")} but ${labelled[0].path} = ${labelled[0].value}`,
          expected: [...new Set(labelled.map((e) => e.value))].slice(0, 5),
        });
        continue;
      }
    }

    if (matches.length === 0 && idx.numbers.some(e => !entityMatches(e) && matchesValue(nc, e))) {
      findings.push({kind:"WRONG_NUMBER",claim,detail:"The value belongs to a different instrument or ticket"});
      continue;
    }
    if (matches.length === 0) {
      findings.push({ kind: "FABRICATION", claim, detail: `"${claim.text}" does not match any value in this turn's tool outputs` });
      continue;
    }

    // Stale price presented as live.
    if (liveContext && matches.every((e) => e.source === "tool" && e.stale === true)) {
      const asOf = matches.find((e) => e.staleAsOf)?.staleAsOf ?? null;
      findings.push({ kind: "STALE_AS_LIVE", claim, detail: `"${claim.text}" comes from stale data${asOf ? ` (as of ${asOf})` : ""} but is presented as live/current` });
    }
  }

  // Fail closed for spelled-out financial quantities the numeric parser cannot verify.
  const words = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)(?:[ -]+(?:and|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion))*\s+(?:dollars?|euros?|pounds?|percent|lots?|pips?)\b/gi;
  for (const m of work.matchAll(words)) {
    const claim = pushClaim({kind: "number", text:m[0], grounded:false, groundedBy:[], localStart:m.index!, localEnd:m.index!+m[0].length});
    findings.push({kind:"FABRICATION",claim,detail:"Spelled-out financial quantity requires a structured numeric source; withheld pending verification"});
  }
  // Check each execution clause, so unrelated negation cannot suppress it.
  const reportedExecutionClauses = new Set<number>();
  for (const m of raw.matchAll(new RegExp(EXECUTION_AFFIRM.source, "gi"))) {
    const before = raw.slice(0, m.index);
    const boundary = [...before.matchAll(/[,;]|\b(?:and|but|while|whereas)\b/gi)].at(-1);
    const clauseStart = boundary ? boundary.index! + boundary[0].length : 0;
    const clause = raw.slice(clauseStart, m.index + m[0].length);
    const prior = raw.slice(0, clauseStart);
    // Coordinated predicates and pronouns retain their order subject, but a
    // new predicate does not inherit unrelated negation ("not failed and was
    // filled"). Restrict inheritance to references/auxiliaries, so an unrelated
    // subject such as "a glass was filled" remains outside execution claims.
    const inheritedContext = !EXECUTION_CONTEXT.test(clause) &&
      /^\s*(?:(?:then|now|subsequently)\s+)?(?:it|they|this|that|was|were|is|are|has|have|had|got|filled|executed|placed|partially|fully|successfully|already|finally)\b/i.test(clause) &&
      EXECUTION_CONTEXT.test(prior);
    if ((!EXECUTION_CONTEXT.test(clause) && !inheritedContext) || EXECUTION_NEGATED.test(clause)) continue;
    // A bare coordinated verb shares the preceding auxiliary: "will be
    // executed and filled", "was not executed and filled". An explicit new
    // auxiliary ("and was filled") makes a separate affirmative claim.
    const priorClause = before.slice(0, boundary?.index ?? 0).split(/[,;]|\b(?:and|but|while|whereas)\b/i).at(-1) ?? "";
    if (inheritedContext && /^\s*(?:(?:partially|fully|successfully|already|finally)\s+)*(?:filled|executed|placed)\b/i.test(clause) &&
      EXECUTION_AFFIRM.test(priorClause) && EXECUTION_NEGATED.test(priorClause)) continue;
    const partialClaim = /partial(?:ly)?\s+$/i.test(before);
    // Suffix identities belong to this execution too ("filled for GBPUSD",
    // "filled, ticket 123"). Stop before the next independent proposition.
    const suffix = raw.slice(m.index + m[0].length);
    const nextClause = suffix.search(/;|\b(?:and|but|while|whereas)\b|,(?!\s*(?:ticket|order|position|action)\s*(?:#|id)?\s*\d)/i);
    const clauseEnd = nextClause < 0 ? raw.length : m.index + m[0].length + nextClause;
    const tickets = claims.filter(c => c.kind === "ticket" && c.start >= seg.start + clauseStart && c.end <= seg.start + clauseEnd).map(c => c.text);
    const symbols = namedSymbols(raw.slice(clauseStart, clauseEnd), idx);
    if (inheritedContext) {
      if (symbols.length === 0) {
        const inheritedSymbol = namedSymbols(prior, idx).at(-1);
        if (inheritedSymbol) symbols.push(inheritedSymbol);
      }
      if (tickets.length === 0) {
        const inheritedTicket = claims.filter(c => c.kind === "ticket" && c.end <= seg.start + clauseStart).at(-1);
        if (inheritedTicket) tickets.push(inheritedTicket.text);
      }
    }
    const proof = idx.executions.filter(e => (e.executed || (partialClaim && e.partial)) &&
      tickets.every(t => e.ids.includes(t)) && symbols.every(symbol => e.symbols.includes(symbol)));
    const claim = pushClaim({ kind: "execution", text: m[0], grounded: proof.length > 0, groundedBy: proof.map(p => p.path), localStart: m.index, localEnd: m.index + m[0].length });
    // Check every affirmation, but one removal notice suffices for coordinated
    // verbs in the same clause ("placed and filled").
    const reportBoundary = [...before.matchAll(/[,;]|\bbut\b/gi)].at(-1);
    const reportStart = reportBoundary ? reportBoundary.index! + reportBoundary[0].length : 0;
    if (proof.length === 0 && !reportedExecutionClauses.has(reportStart)) {
      reportedExecutionClauses.add(reportStart);
      const statuses = idx.executions.map(e => e.status).filter(Boolean);
      findings.push({ kind: "EXECUTION_UNCONFIRMED", claim, detail: `"${m[0]}" claimed but no tool output this turn shows an executed result${statuses.length ? ` (statuses seen: ${[...new Set(statuses)].join(", ")})` : ""}` });
    }
  }

  return { claims, findings };
}

export { splitKey };
