// Truth evidence classes (pure, additive).
//
// Owner brief: "Distinguish verified information, estimates, stale data, and
// unavailable information." The Truth snapshot already carries a feed-level
// `data.state`; this module classifies EACH displayed claim (price, last candle,
// last tick, news/calendar, every component vote, the level geometry and the
// composed verdict) from facts the snapshot already holds.
//
// CONSERVATIVE RULES (enforced here, tested in __qa__/evidenceClass.test.ts):
//  - "verified" is reserved for a direct observation from a feed that is
//    LIVE_CONFIRMED, has an identified source and a parsable observation time.
//  - Anything computed by a model/heuristic (component votes, verdict, entry /
//    stop / target geometry, grades, scores) is AT BEST "estimate", even when
//    every input is fresh. A derived claim can never outrank the feed it rests on.
//  - Anything past its freshness budget (feed STALE, or the read expired) is
//    "stale".
//  - Absent, withheld, unattributed or unmeasured is "unavailable" — never
//    coerced into a value.
//  - Clients may only DOWNGRADE a server classification (`downgradeTruthEvidence`).
//
// Pure: no clock reads (the caller passes `nowMs`), no I/O. Advisory only — this
// labels what a surface shows; it never gates, slows, or places a trade.

import type {
  TruthBias,
  TruthComponentKey,
  TruthDataState,
} from "./truth.types.js";

/** Ordered from most to least trustworthy. */
export type TruthEvidenceClass = "verified" | "estimate" | "stale" | "unavailable";

export const TRUTH_EVIDENCE_CLASSES: readonly TruthEvidenceClass[] = [
  "verified",
  "estimate",
  "stale",
  "unavailable",
];

/** Short, machine-readable reason behind a classification. */
export type TruthEvidenceReason =
  // verified
  | "LIVE_FEED_OBSERVATION"
  // estimate
  | "MODEL_ESTIMATE"
  | "FEED_UNCONFIRMED"
  | "CALENDAR_FETCH_TIME_UNKNOWN"
  // stale
  | "FEED_STALE"
  | "EXPIRED"
  // unavailable
  | "NO_FEED"
  | "NO_VALUE"
  | "NO_OBSERVATION_TIME"
  | "INVALID_TIMESTAMP"
  | "NO_CALENDAR"
  | "CALENDAR_UNCHECKED"
  | "COMPONENT_ABSENT"
  | "LEVELS_WITHHELD"
  | "INSUFFICIENT_DATA"
  | "UNCLASSIFIED";

export const TRUTH_EVIDENCE_REASONS: readonly TruthEvidenceReason[] = [
  "LIVE_FEED_OBSERVATION",
  "MODEL_ESTIMATE",
  "FEED_UNCONFIRMED",
  "CALENDAR_FETCH_TIME_UNKNOWN",
  "FEED_STALE",
  "EXPIRED",
  "NO_FEED",
  "NO_VALUE",
  "NO_OBSERVATION_TIME",
  "INVALID_TIMESTAMP",
  "NO_CALENDAR",
  "CALENDAR_UNCHECKED",
  "COMPONENT_ABSENT",
  "LEVELS_WITHHELD",
  "INSUFFICIENT_DATA",
  "UNCLASSIFIED",
];

/** The reason codes each class may carry (a mismatched pair is malformed). */
const REASON_CLASS: Record<TruthEvidenceReason, TruthEvidenceClass> = {
  LIVE_FEED_OBSERVATION: "verified",
  MODEL_ESTIMATE: "estimate",
  FEED_UNCONFIRMED: "estimate",
  CALENDAR_FETCH_TIME_UNKNOWN: "estimate",
  FEED_STALE: "stale",
  EXPIRED: "stale",
  NO_FEED: "unavailable",
  NO_VALUE: "unavailable",
  NO_OBSERVATION_TIME: "unavailable",
  INVALID_TIMESTAMP: "unavailable",
  NO_CALENDAR: "unavailable",
  CALENDAR_UNCHECKED: "unavailable",
  COMPONENT_ABSENT: "unavailable",
  LEVELS_WITHHELD: "unavailable",
  INSUFFICIENT_DATA: "unavailable",
  UNCLASSIFIED: "unavailable",
};

/** One claim's classification. */
export interface TruthClaimEvidence {
  evidenceClass: TruthEvidenceClass;
  reason: TruthEvidenceReason;
  /**
   * The DATA timestamp this claim rests on (never build/read time), or null
   * when none is known. For price / last candle this is the feed's candle
   * close boundary, which can be the scheduled end of a forming bar — it
   * identifies the bar; it is not proof of finality.
   */
  observedAt: string | null;
}

export interface TruthEvidence {
  price: TruthClaimEvidence;
  lastCandle: TruthClaimEvidence;
  lastTick: TruthClaimEvidence;
  news: TruthClaimEvidence;
  components: Record<TruthComponentKey, TruthClaimEvidence>;
  levels: TruthClaimEvidence;
  verdict: TruthClaimEvidence;
}

export interface TruthEvidenceInput {
  /** Caller's clock (ms). Only used to reject future tick observations. */
  nowMs: number;
  data: {
    state: TruthDataState;
    source: string | null;
    price: number | null;
    lastCandleAt: string | null;
    lastTickAt: string | null;
  };
  news: {
    providerConnected: boolean;
    /**
     * Scheduled event risk could not be checked: the calendar read failed, or
     * a configured calendar is not connected. Distinct from "no calendar is
     * configured". Absent (older server) is treated as false.
     */
    riskUnchecked?: boolean;
  };
  components: Record<TruthComponentKey, { present: boolean; asOf: string | null }>;
  levels: { withheld: boolean };
  verdict: { bias: TruthBias };
}

/** Clock skew tolerated before a tick time counts as "in the future". */
export const TRUTH_EVIDENCE_TICK_SKEW_MS = 5_000;

const COMPONENT_KEYS: readonly TruthComponentKey[] = ["scanner", "flame", "timing", "scalp"];

function claim(
  reason: TruthEvidenceReason,
  observedAt: string | null,
): TruthClaimEvidence {
  return { evidenceClass: REASON_CLASS[reason], reason, observedAt };
}

function parsable(iso: string | null | undefined): iso is string {
  return typeof iso === "string" && Number.isFinite(Date.parse(iso));
}

/** Class of a DIRECT feed observation, from the feed state alone. */
function feedClaim(
  state: TruthDataState,
  source: string | null,
  observedAt: string | null,
): TruthClaimEvidence {
  if (!source || state === "UNAVAILABLE") return claim("NO_FEED", observedAt);
  if (state === "STALE") return claim("FEED_STALE", observedAt);
  if (state === "SYNCING") return claim("FEED_UNCONFIRMED", observedAt);
  return claim("LIVE_FEED_OBSERVATION", observedAt);
}

/** A derived (heuristic) claim can never outrank the feed it rests on, and is
 * never better than "estimate". */
function derivedFrom(feed: TruthClaimEvidence, observedAt: string | null): TruthClaimEvidence {
  switch (feed.reason) {
    case "LIVE_FEED_OBSERVATION":
      return claim("MODEL_ESTIMATE", observedAt);
    case "FEED_UNCONFIRMED":
      return claim("FEED_UNCONFIRMED", observedAt);
    case "FEED_STALE":
      return claim("FEED_STALE", observedAt);
    default:
      return claim("NO_FEED", observedAt);
  }
}

/** Oldest parsable timestamp — the weakest observation a composite rests on. */
function oldest(stamps: (string | null)[]): string | null {
  let best: string | null = null;
  let bestMs = Infinity;
  for (const s of stamps) {
    if (!parsable(s)) continue;
    const ms = Date.parse(s);
    if (ms < bestMs) {
      bestMs = ms;
      best = s;
    }
  }
  return best;
}

/**
 * Classify every claim of a Truth snapshot. Pure and deterministic.
 */
export function classifyTruthEvidence(input: TruthEvidenceInput): TruthEvidence {
  const { data, nowMs } = input;

  // ── Last candle: bar identity from the feed. A future scheduled close is the
  // normal forming-bar boundary, so it is NOT rejected here — only an absent or
  // unparsable stamp is.
  const candleAt = data.lastCandleAt;
  const lastCandle = candleAt == null
    ? claim("NO_VALUE", null)
    : !parsable(candleAt)
      ? claim("INVALID_TIMESTAMP", null)
      : feedClaim(data.state, data.source, candleAt);

  // ── Price: newest close. Needs a value AND the bar it came from.
  const priceUsable = data.price != null && Number.isFinite(data.price) && data.price > 0;
  const price = !priceUsable
    ? claim("NO_VALUE", null)
    : lastCandle.reason === "NO_VALUE" || lastCandle.reason === "INVALID_TIMESTAMP"
      ? claim("NO_OBSERVATION_TIME", null)
      : feedClaim(data.state, data.source, candleAt);

  // ── Last tick: a real observation time; a future one is not an observation.
  const tickAt = data.lastTickAt;
  const lastTick = tickAt == null
    ? claim("NO_VALUE", null)
    : !parsable(tickAt) || Date.parse(tickAt) > nowMs + TRUTH_EVIDENCE_TICK_SKEW_MS
      ? claim("INVALID_TIMESTAMP", null)
      : feedClaim(data.state, data.source, tickAt);

  // ── News / calendar. The snapshot does not carry the calendar's fetch time,
  // so even a connected provider is never labelled "verified" here. A calendar
  // that could not be checked is unavailable for that reason — never
  // described as "not connected", and never as an estimate.
  const news = input.news.riskUnchecked === true
    ? claim("CALENDAR_UNCHECKED", null)
    : input.news.providerConnected
      ? claim("CALENDAR_FETCH_TIME_UNKNOWN", null)
      : claim("NO_CALENDAR", null);

  // ── Components: heuristic reads over the feed.
  const feed = feedClaim(data.state, data.source, candleAt);
  const components = {} as Record<TruthComponentKey, TruthClaimEvidence>;
  for (const key of COMPONENT_KEYS) {
    const c = input.components[key];
    if (!c || !c.present) components[key] = claim("COMPONENT_ABSENT", null);
    else if (!parsable(c.asOf)) components[key] = claim("NO_OBSERVATION_TIME", null);
    else components[key] = derivedFrom(feed, c.asOf);
  }

  // ── Levels: scanner geometry is an estimate at best.
  const levels = input.levels.withheld
    ? claim("LEVELS_WITHHELD", null)
    : components.scanner.reason === "COMPONENT_ABSENT" || components.scanner.reason === "NO_OBSERVATION_TIME"
      ? claim("NO_OBSERVATION_TIME", null)
      : derivedFrom(feed, components.scanner.observedAt);

  // ── Verdict: a composite heuristic over the present components.
  const presentAsOf = COMPONENT_KEYS
    .filter((k) => components[k].evidenceClass !== "unavailable")
    .map((k) => components[k].observedAt);
  const verdict = input.verdict.bias === "UNKNOWN"
    ? claim("INSUFFICIENT_DATA", null)
    : derivedFrom(feed, oldest(presentAsOf));

  return { price, lastCandle, lastTick, news, components, levels, verdict };
}

/**
 * Mark the derived claims of an expired read as stale. Direct data claims keep
 * their own classification — their timestamps are unchanged by expiry.
 */
export function expireTruthEvidence(evidence: TruthEvidence): TruthEvidence {
  const expire = (c: TruthClaimEvidence): TruthClaimEvidence =>
    c.evidenceClass === "verified" || c.evidenceClass === "estimate"
      ? { evidenceClass: "stale", reason: "EXPIRED", observedAt: c.observedAt }
      : c;
  return {
    ...evidence,
    components: {
      scanner: expire(evidence.components.scanner),
      flame: expire(evidence.components.flame),
      timing: expire(evidence.components.timing),
      scalp: expire(evidence.components.scalp),
    },
    levels: expire(evidence.levels),
    verdict: expire(evidence.verdict),
  };
}

/** Lower is weaker. */
export function truthEvidenceRank(c: TruthEvidenceClass): number {
  return 3 - TRUTH_EVIDENCE_CLASSES.indexOf(c);
}

/** Validate an untrusted claim (e.g. off the wire). Malformed → unavailable. */
export function parseTruthClaimEvidence(value: unknown): TruthClaimEvidence {
  const v = value as Partial<TruthClaimEvidence> | null | undefined;
  const reason = v?.reason as TruthEvidenceReason | undefined;
  if (
    v == null || typeof v !== "object" ||
    !TRUTH_EVIDENCE_CLASSES.includes(v.evidenceClass as TruthEvidenceClass) ||
    reason == null || !TRUTH_EVIDENCE_REASONS.includes(reason) ||
    REASON_CLASS[reason] !== v.evidenceClass ||
    !(v.observedAt === null || parsable(v.observedAt))
  ) {
    return claim("UNCLASSIFIED", null);
  }
  return { evidenceClass: v.evidenceClass as TruthEvidenceClass, reason, observedAt: v.observedAt };
}

/** The weaker of two claims; on a tie the supplied (server) claim is kept. */
function weaker(supplied: TruthClaimEvidence, local: TruthClaimEvidence): TruthClaimEvidence {
  return truthEvidenceRank(local.evidenceClass) < truthEvidenceRank(supplied.evidenceClass)
    ? local
    : supplied;
}

/**
 * Client-side cap: combine a SUPPLIED (server) classification with a LOCAL
 * re-classification of the (possibly already capped) snapshot. Each claim takes
 * the weaker of the two, so a client can only ever downgrade. A missing supplied
 * object returns null — no classification is invented for an older server.
 */
export function downgradeTruthEvidence(
  supplied: unknown,
  local: TruthEvidence,
): TruthEvidence | null {
  if (supplied == null || typeof supplied !== "object") return null;
  const s = supplied as Record<string, unknown>;
  const sc = (s.components ?? {}) as Record<string, unknown>;
  const pick = (v: unknown, l: TruthClaimEvidence) => weaker(parseTruthClaimEvidence(v), l);
  return {
    price: pick(s.price, local.price),
    lastCandle: pick(s.lastCandle, local.lastCandle),
    lastTick: pick(s.lastTick, local.lastTick),
    news: pick(s.news, local.news),
    components: {
      scanner: pick(sc.scanner, local.components.scanner),
      flame: pick(sc.flame, local.components.flame),
      timing: pick(sc.timing, local.components.timing),
      scalp: pick(sc.scalp, local.components.scalp),
    },
    levels: pick(s.levels, local.levels),
    verdict: pick(s.verdict, local.verdict),
  };
}

// ── Clean-English copy shared by every surface ──────────────────────────────

export const TRUTH_EVIDENCE_CLASS_LABEL: Record<TruthEvidenceClass, string> = {
  verified: "Verified",
  estimate: "Estimate",
  stale: "Stale",
  unavailable: "Unavailable",
};

export const TRUTH_EVIDENCE_REASON_TEXT: Record<TruthEvidenceReason, string> = {
  LIVE_FEED_OBSERVATION: "Observed on the confirmed live feed.",
  MODEL_ESTIMATE: "Calculated by ARX from current data — an estimate, not an observation.",
  FEED_UNCONFIRMED: "The live feed is not confirmed yet, so this is not verified.",
  CALENDAR_FETCH_TIME_UNKNOWN: "From the connected calendar; when it was last fetched isn't reported.",
  FEED_STALE: "The feed behind this has gone stale.",
  EXPIRED: "This read expired; waiting for current evidence.",
  NO_FEED: "No usable market-data feed backs this.",
  NO_VALUE: "No value is available.",
  NO_OBSERVATION_TIME: "There is no observation time to attribute this to.",
  INVALID_TIMESTAMP: "The reported time is invalid, so it is not used.",
  NO_CALENDAR: "No economic calendar is connected.",
  CALENDAR_UNCHECKED: "The economic calendar could not be checked right now.",
  COMPONENT_ABSENT: "This read has no current, matching evidence.",
  LEVELS_WITHHELD: "Entry, stop and target are withheld.",
  INSUFFICIENT_DATA: "There is not enough confirmed data for a read.",
  UNCLASSIFIED: "This value's evidence could not be checked.",
};
