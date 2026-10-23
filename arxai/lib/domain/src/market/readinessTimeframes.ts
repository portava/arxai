// ── SHARED PER-TIMEFRAME READINESS FLOOR + DISPLAY-TOKEN NORMALIZER ──────────
//
// The ONE source of (a) the per-timeframe minimum closed-bar floor and (b) the
// normalized display timeframe token that the Trade Health / Eligibility DISPLAY
// contract and its callers (Scanner, Ruby) feed in so they agree for the SAME
// real-world facts.
//
// WHY this exists:
//   - Floor: without a shared per-timeframe floor, the Scanner (which requires a
//     per-timeframe minimum, e.g. 150 closed 1m bars) and Ruby (which fell back to
//     the bare MIN_SUFFICIENT_CLOSED_BARS of 5) would label the SAME symbol +
//     timeframe differently in the thin-history window — Ruby "Live-confirmed"
//     while the Scanner says "Building history". Feeding both the same floor makes
//     the shared label/affordances agree.
//   - Token: Ruby passes canonical MT5 timeframes ("M15", "H1") while the Scanner
//     passes UI aliases ("15m", "1h"). The contract embeds the timeframe in its
//     trust line, so normalizing both to ONE display token keeps the trust line
//     identical across surfaces.
//
// SAFETY — PURE + DISPLAY-ONLY. A larger floor can only DOWNGRADE a read (demand
// more bars), never grant eligibility. This module takes no role/privilege input
// and is never an execution gate; the 18-gate dispatch, synthetic floor, SL
// policy, kill switch, and per-user arming/approval remain the sole execution
// authority.
//
// The floor values mirror the scanner's `TIMEFRAME_THRESHOLDS.minCandles`. A
// drift-lock test (scannerTruth.test.ts) asserts the two never diverge, so this
// stays "one truth" WITHOUT restructuring the verified scanner threshold table.

/** Per-timeframe minimum CLOSED bars required before a read is "sufficient".
 *  Keyed by the canonical lower-case display alias (see normalizeReadinessTimeframe). */
const READINESS_MIN_CLOSED_BARS: Record<string, number> = {
  "1m": 150,
  "2m": 150,
  "3m": 150,
  "4m": 150,
  "5m": 150,
  "6m": 150,
  "10m": 130,
  "12m": 130,
  "15m": 120,
  "20m": 115,
  "30m": 110,
  "1h": 100,
  "2h": 95,
  "3h": 90,
  "4h": 80,
  "6h": 75,
  "8h": 70,
  "12h": 65,
  "1d": 50,
  "1w": 30,
  "1mo": 12,
};

/** The strictest floor — the conservative (downgrade-only) default for an
 *  unrecognized timeframe. Demanding the most bars can never over-grant. */
const STRICTEST_READINESS_FLOOR = 150;

/**
 * Normalize any timeframe spelling to ONE lower-case display alias so the trust
 * line (and floor lookup) match regardless of which caller produced it. Accepts:
 *  - canonical MT5 codes: "M1".."M30", "H1".."H12", "D1", "W1", "MN1"
 *  - lower/upper UI aliases: "15m", "1H", "1d", "1w", "1mo"
 * Unrecognized input is returned lower-cased unchanged (display fallback).
 */
export function normalizeReadinessTimeframe(raw: string): string {
  const t = (raw ?? "").trim();
  if (!t) return "";
  const upper = t.toUpperCase();
  let m: RegExpMatchArray | null;
  // Month FIRST (canonical "MN1" / alias "1MO") so the bare-M minute patterns
  // below can never swallow a monthly timeframe. Match ONLY the supported "MN1"
  // (not "MN", "MN2", …) so unsupported monthly-like tokens fall through to the
  // lower-cased fallback and earn the strictest floor — never the lenient 12.
  if (upper === "MN1") return "1mo";
  if ((m = upper.match(/^(\d+)MO$/))) return `${Number(m[1])}mo`;
  // Canonical MT5 forms: M15 / H1 / D1 / W1.
  if ((m = upper.match(/^M(\d+)$/))) return `${Number(m[1])}m`;
  if ((m = upper.match(/^H(\d+)$/))) return `${Number(m[1])}h`;
  if ((m = upper.match(/^D(\d+)$/))) return `${Number(m[1])}d`;
  if ((m = upper.match(/^W(\d+)$/))) return `${Number(m[1])}w`;
  // Alias forms: 15M / 1H / 1D / 1W.
  if ((m = upper.match(/^(\d+)M$/))) return `${Number(m[1])}m`;
  if ((m = upper.match(/^(\d+)H$/))) return `${Number(m[1])}h`;
  if ((m = upper.match(/^(\d+)D$/))) return `${Number(m[1])}d`;
  if ((m = upper.match(/^(\d+)W$/))) return `${Number(m[1])}w`;
  return t.toLowerCase();
}

/**
 * The minimum CLOSED bars a timeframe needs before a read may be "sufficient".
 * Display-only and downgrade-only: an unrecognized timeframe falls back to the
 * STRICTEST floor (never the laxest), so the worst case demands MORE bars.
 */
export function requiredClosedBarsForTimeframe(raw: string): number {
  const key = normalizeReadinessTimeframe(raw);
  return READINESS_MIN_CLOSED_BARS[key] ?? STRICTEST_READINESS_FLOOR;
}
