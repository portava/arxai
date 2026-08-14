// ARX Fund Book — Weekly investor account story, PURE math + narrative builder
// (Task #143). No DB, no IO. Deterministic and unit-testable in isolation.
//
// SAFETY / HONESTY (inviolable):
// - The builder is a pure function of already-aggregated, investor-SAFE inputs.
//   It NEVER invents a reason, a market prediction, or a number it was not given.
// - Net change is derived ONLY from a real baseline (the immediately-preceding
//   PUBLISHED report's end value). With no baseline the builder reports
//   netChange = null + an honest "starting baseline" story — it never guesses.
// - Economic impact: netChange = flows + marketChange. flows come straight from
//   recorded ledger movements; marketChange is the residual (netChange − flows)
//   and is null whenever netChange is null. No baseline ⇒ no marketChange claim.
// - "What Ruby is watching next week" is STATE-derived only (a pool under review,
//   elevated drawdown, a deposit lock releasing next week, stale data). It is
//   never a fabricated forecast.
// - No paper / simulation / mock / demo / guaranteed-return wording anywhere.

import { round2 } from "./navMath.js";
import type { ValueFreshness } from "./valueFreshness.js";

// Drawdown at or above this percent is surfaced as an elevated-risk watch item.
export const ELEVATED_DRAWDOWN_PCT = 10;
// How many pools to list as top positive / negative contributors.
export const TOP_CONTRIBUTORS = 3;
export const WEEKLY_STORY_SCHEMA_VERSION = 1 as const;

// ── ISO week helpers (UTC) ──────────────────────────────────────────────────

/** Day index with Monday = 0 … Sunday = 6. */
function isoDayIndex(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}

/** The ISO week key ("YYYY-Www") that contains the given instant (UTC). */
export function isoWeekKeyOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Shift to the Thursday of this week — the ISO week-year is the Thursday's year.
  d.setUTCDate(d.getUTCDate() - isoDayIndex(d) + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - isoDayIndex(firstThursday) + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / 604_800_000);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** The current ISO week key (defaults to now). */
export function currentIsoWeekKey(now: Date = new Date()): string {
  return isoWeekKeyOf(now);
}

/**
 * Number of ISO weeks (52 or 53) in a given ISO week-year. Dec 28 always falls
 * in the final ISO week of its year, so its week number is the year's count.
 */
function weeksInIsoYear(isoYear: number): number {
  const dec28 = new Date(Date.UTC(isoYear, 11, 28));
  const key = isoWeekKeyOf(dec28);
  return Number(key.slice(key.indexOf("W") + 1));
}

/** Parse a "YYYY-Www" key into its numeric (isoYear, week). Throws if invalid. */
function parsePeriodKey(periodKey: string): { isoYear: number; week: number } {
  const m = /^(\d{4})-W(\d{2})$/.exec(periodKey);
  if (!m) throw new Error(`INVALID_PERIOD_KEY:${periodKey}`);
  const isoYear = Number(m[1]);
  const week = Number(m[2]);
  if (!Number.isFinite(isoYear) || !Number.isFinite(week) || week < 1 || week > 53) {
    throw new Error(`INVALID_PERIOD_KEY:${periodKey}`);
  }
  if (week > weeksInIsoYear(isoYear)) {
    throw new Error(`INVALID_PERIOD_KEY:${periodKey}`);
  }
  return { isoYear, week };
}

/** Validate a "YYYY-Www" key without throwing. */
export function isValidPeriodKey(periodKey: string): boolean {
  try {
    parsePeriodKey(periodKey);
    return true;
  } catch {
    return false;
  }
}

export interface IsoWeekRange {
  periodKey: string;
  /** Monday 00:00:00.000 UTC (inclusive). */
  periodStart: Date;
  /** The following Monday 00:00:00.000 UTC (exclusive). */
  periodEnd: Date;
}

/** The half-open [Monday, next Monday) UTC range for an ISO week key. */
export function isoWeekRangeOf(periodKey: string): IsoWeekRange {
  const { isoYear, week } = parsePeriodKey(periodKey);
  // Monday of ISO week 1 is the Monday on/before Jan 4 of the ISO year.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week1Monday = new Date(jan4.getTime());
  week1Monday.setUTCDate(jan4.getUTCDate() - isoDayIndex(jan4));
  const periodStart = new Date(week1Monday.getTime());
  periodStart.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  const periodEnd = new Date(periodStart.getTime());
  periodEnd.setUTCDate(periodStart.getUTCDate() + 7);
  return { periodKey, periodStart, periodEnd };
}

/** The ISO week key immediately before the given key. */
export function previousIsoWeekKey(periodKey: string): string {
  const { periodStart } = isoWeekRangeOf(periodKey);
  const prior = new Date(periodStart.getTime() - 86_400_000); // a day into the prior week
  return isoWeekKeyOf(prior);
}

/** The ISO week key immediately after the given key. */
export function nextIsoWeekKey(periodKey: string): string {
  const { periodEnd } = isoWeekRangeOf(periodKey);
  return isoWeekKeyOf(periodEnd);
}

// ── Formatting (investor-safe, deterministic) ───────────────────────────────

/** Format a USD magnitude as "$1,234.56" (no sign). */
export function formatUsd(n: number): string {
  const v = Number.isFinite(n) ? Math.abs(round2(n)) : 0;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Format a signed USD value as "+$1.00" / "-$1.00" / "$0.00". */
export function formatSignedUsd(n: number): string {
  const r = Number.isFinite(n) ? round2(n) : 0;
  if (r > 0) return `+${formatUsd(r)}`;
  if (r < 0) return `-${formatUsd(r)}`;
  return formatUsd(0);
}

// ── Builder input / output contracts ────────────────────────────────────────

export interface PoolContributionInput {
  poolKey: string;
  name: string;
  riskLevel: string;
  // OK | UNDER_REVIEW
  navStatus: string;
  unitsOwned: number;
  // Settled value at the snapshot: units × pool NAV.
  settledValue: number;
  // The investor's OWN verified pro-rata floating-P/L share for this pool.
  floatingPlShare: number;
  // Signed recorded net flows into this pool in the window
  // (deposits + distributions − withdrawals), from the unit ledger + waterfall.
  flowsInWindow: number;
}

export interface WeeklyStoryInput {
  periodKey: string;
  periodStart: string; // ISO
  periodEnd: string; // ISO
  // End-of-window total value (Σ settledValue + Σ floatingPlShare).
  endValue: number;
  // The immediately-preceding PUBLISHED report's end value (the baseline).
  baselineValue: number | null;
  baselineAvailable: boolean;
  baselinePeriodKey: string | null;
  // Recorded flows in the window (each a non-negative magnitude except
  // distributions, which is signed — a reversal can be negative).
  deposits: number;
  withdrawals: number;
  distributions: number;
  pools: PoolContributionInput[];
  // Own net-value drawdown (settled + floating share) from its high-water mark.
  drawdownPercent: number | null;
  drawdownUsd: number | null;
  // Deposit-lock status at the snapshot.
  lockedPrincipal: number;
  withdrawableValue: number;
  nextReleaseAt: string | null; // ISO
  // True when a deposit lock releases within the FOLLOWING ISO week.
  lockReleasesNextWeek: boolean;
  // Honesty signals.
  navStatus: "OK" | "UNDER_REVIEW";
  freshness: ValueFreshness;
  freshnessMessage: string; // investor-safe message (never an internal)
}

export interface EconomicImpact {
  netChange: number | null;
  flows: number;
  marketChange: number | null;
  // True only when a week-over-week change figure is claimed (a baseline exists
  // AND the values are verifiable — not under review, not stale/missing). When
  // false, netChange/marketChange are null and no performance claim is made.
  changeVerifiable: boolean;
  deposits: number;
  withdrawals: number;
  distributions: number;
  baselineAvailable: boolean;
  baselineValue: number | null;
  baselinePeriodKey: string | null;
  // Null when the change is not verifiable (under review / stale). endValue and
  // baselineValue are withheld together so a week-over-week change can never be
  // reconstructed from the payload while values are unverifiable.
  endValue: number | null;
}

export interface PoolBreakdownLine {
  poolKey: string;
  name: string;
  riskLevel: string;
  // Valuation-bearing fields are null when the change is not verifiable (under
  // review / stale). They are withheld together with the headline change so the
  // investor can never reconstruct the current account total — and thus
  // week-over-week change vs a prior published report — by summing pool values.
  settledValue: number | null;
  floatingPlShare: number | null;
  endValue: number | null;
  flowsInWindow: number;
  sharePct: number | null;
  navStatus: string;
  underReview: boolean;
}

export interface Contributor {
  poolKey: string;
  name: string;
  floatingPlShare: number;
}

export type WatchKind =
  | "POOL_UNDER_REVIEW"
  | "ELEVATED_DRAWDOWN"
  | "LOCK_RELEASING"
  | "STALE_DATA";

export interface WatchItem {
  kind: WatchKind;
  message: string;
}

export interface WeeklyAccountStory {
  schemaVersion: typeof WEEKLY_STORY_SCHEMA_VERSION;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  headline: string;
  summary: string;
  economicImpact: EconomicImpact;
  pools: PoolBreakdownLine[];
  topPositive: Contributor[];
  topNegative: Contributor[];
  risk: {
    drawdownPercent: number | null;
    drawdownUsd: number | null;
    elevated: boolean;
  };
  depositLock: {
    // lockedPrincipal + withdrawableValue == the current account total, so both
    // are withheld (null) when values are unverifiable to close that
    // reconstruction channel. The schedule fields stay (pure state, no value).
    lockedPrincipal: number | null;
    withdrawableValue: number | null;
    nextReleaseAt: string | null;
    releasesNextWeek: boolean;
  };
  watching: WatchItem[];
  dataQuality: {
    navStatus: "OK" | "UNDER_REVIEW";
    freshness: ValueFreshness;
    freshnessMessage: string;
    baselineAvailable: boolean;
  };
  disclosures: string[];
}

const BASE_DISCLOSURE =
  "Every figure here is drawn only from your own recorded account activity — your units, the pool NAV, your verified pro-rata share of open positions, and your own deposits, withdrawals, and distributions. Nothing is derived from any shared broker balance.";

// ── The deterministic builder ───────────────────────────────────────────────

/**
 * Build the investor-safe weekly account story from already-aggregated, safe
 * inputs. Pure and deterministic: identical input always yields identical
 * output, which is what makes a PUBLISHED snapshot reproducible.
 */
export function buildWeeklyAccountStory(input: WeeklyStoryInput): WeeklyAccountStory {
  const endValue = round2(input.endValue);
  const deposits = round2(Math.max(0, input.deposits));
  const withdrawals = round2(Math.max(0, input.withdrawals));
  const distributions = round2(input.distributions);
  const flows = round2(deposits - withdrawals + distributions);

  const underReview = input.navStatus === "UNDER_REVIEW";
  const staleData = input.freshness === "STALE" || input.freshness === "MISSING";
  // A week-over-week change is only claimed when the underlying values are
  // verifiable: NOT under reconciliation review AND NOT stale/missing. When
  // unverifiable we OMIT the numeric claim entirely rather than guess.
  const changeVerifiable = !underReview && !staleData;

  const hasBaseline = input.baselineAvailable && input.baselineValue != null;
  const baselineValue = hasBaseline ? round2(input.baselineValue as number) : null;
  const canShowChange = hasBaseline && changeVerifiable;
  const netChange = canShowChange ? round2(endValue - (baselineValue as number)) : null;
  const marketChange = netChange != null ? round2(netChange - flows) : null;

  // Per-pool breakdown. sharePct is each pool's share of the total end value
  // (settled + floating share), floored at 0 so it never goes negative.
  const totalEnd = input.pools.reduce(
    (acc, p) => acc + round2(p.settledValue + p.floatingPlShare),
    0,
  );
  const pools: PoolBreakdownLine[] = input.pools.map((p) => {
    const poolEnd = round2(p.settledValue + p.floatingPlShare);
    const sharePct =
      totalEnd > 0 ? round2(Math.max(0, (poolEnd / totalEnd) * 100)) : 0;
    return {
      poolKey: p.poolKey,
      name: p.name,
      riskLevel: p.riskLevel,
      // Valuation numbers are withheld together with the headline change when
      // values are unverifiable so summing pool end-values can't reconstruct the
      // current account total (and thus the change vs a prior published report).
      // Recorded flows-in-window stay visible (booked, not a valuation claim).
      settledValue: changeVerifiable ? round2(p.settledValue) : null,
      floatingPlShare: changeVerifiable ? round2(p.floatingPlShare) : null,
      endValue: changeVerifiable ? poolEnd : null,
      flowsInWindow: round2(p.flowsInWindow),
      sharePct: changeVerifiable ? sharePct : null,
      navStatus: p.navStatus,
      underReview: p.navStatus === "UNDER_REVIEW",
    };
  });

  // Top contributors keyed off the investor's OWN verified floating-P/L share —
  // the only honest per-pool performance signal we have without fabricating a
  // per-pool baseline. Ties broken by poolKey for determinism.
  const ranked = [...input.pools]
    .map((p) => ({
      poolKey: p.poolKey,
      name: p.name,
      floatingPlShare: round2(p.floatingPlShare),
    }))
    .sort((a, b) =>
      b.floatingPlShare - a.floatingPlShare ||
      a.poolKey.localeCompare(b.poolKey),
    );
  // Contributors expose per-pool floating P/L (a valuation-derived performance
  // claim), so they are withheld entirely while values are unverifiable.
  const topPositive = changeVerifiable
    ? ranked.filter((c) => c.floatingPlShare > 0).slice(0, TOP_CONTRIBUTORS)
    : [];
  const topNegative = changeVerifiable
    ? ranked
        .filter((c) => c.floatingPlShare < 0)
        .slice()
        .reverse()
        .slice(0, TOP_CONTRIBUTORS)
    : [];

  // Drawdown is current-value-vs-high-water — an unverified performance signal
  // while values are under review / stale, so it is not surfaced then.
  const elevatedDrawdown =
    changeVerifiable &&
    input.drawdownPercent != null &&
    input.drawdownPercent >= ELEVATED_DRAWDOWN_PCT;

  // State-derived watch items only — never a market forecast.
  const watching: WatchItem[] = [];
  for (const p of pools) {
    if (p.underReview) {
      watching.push({
        kind: "POOL_UNDER_REVIEW",
        message: `Your ${p.name} pool value is being verified; figures there will settle once the review completes.`,
      });
    }
  }
  if (elevatedDrawdown) {
    watching.push({
      kind: "ELEVATED_DRAWDOWN",
      message: `Your account is ${round2(input.drawdownPercent as number)}% below its high-water mark, so risk controls stay in focus.`,
    });
  }
  if (input.lockReleasesNextWeek && input.nextReleaseAt) {
    watching.push({
      kind: "LOCK_RELEASING",
      message: "A deposit lock is scheduled to release next week, increasing your withdrawable amount.",
    });
  }
  if (input.freshness === "STALE" || input.freshness === "MISSING") {
    watching.push({
      kind: "STALE_DATA",
      message: input.freshnessMessage,
    });
  }

  // Headline + summary. Under review never claims a number; no-baseline frames
  // an honest starting snapshot; otherwise plain-language net change.
  let headline: string;
  let summary: string;
  if (underReview) {
    headline = `Your ${input.periodKey} account values are being verified.`;
    summary =
      "Some of your pool values are under review this week, so we're holding off on a net-change figure until they settle. Your recorded deposits, withdrawals, and distributions are shown below exactly as booked.";
  } else if (staleData) {
    headline = `Your ${input.periodKey} account figures are still updating.`;
    summary =
      `${input.freshnessMessage} We're holding off on a week-over-week change figure until your latest values come through. Your recorded deposits, withdrawals, and distributions are shown below exactly as booked.`;
  } else if (!hasBaseline) {
    headline = `Your starting account snapshot for ${input.periodKey}.`;
    summary =
      `This is your first recorded weekly snapshot, so there's no prior week to compare against yet. Your account value is ${formatUsd(endValue)} as of the end of the week. From next week onward you'll see your week-over-week change here.`;
  } else {
    const nc = netChange as number;
    if (nc > 0) headline = `Your account grew by ${formatUsd(nc)} this week.`;
    else if (nc < 0) headline = `Your account declined by ${formatUsd(nc)} this week.`;
    else headline = "Your account was steady this week.";

    const parts: string[] = [];
    parts.push(
      `Your account ${nc > 0 ? "rose" : nc < 0 ? "fell" : "held"} from ${formatUsd(baselineValue as number)} to ${formatUsd(endValue)} (${formatSignedUsd(nc)}).`,
    );
    if (flows !== 0) {
      parts.push(
        `Of that, ${formatSignedUsd(flows)} came from your own deposits, withdrawals, and distributions`,
      );
      if (marketChange != null) {
        parts[parts.length - 1] +=
          `, and ${formatSignedUsd(marketChange)} from how your pools performed.`;
      } else {
        parts[parts.length - 1] += ".";
      }
    } else if (marketChange != null) {
      parts.push(
        `With no deposits or withdrawals this week, the full ${formatSignedUsd(marketChange)} reflects how your pools performed.`,
      );
    }
    summary = parts.join(" ");
  }

  const disclosures = [BASE_DISCLOSURE];
  if (!hasBaseline && changeVerifiable) {
    disclosures.push(
      "No week-over-week change is shown because there is no earlier published week to compare against yet.",
    );
  }
  if (hasBaseline && !changeVerifiable) {
    disclosures.push(
      "Your week-over-week change is withheld this week until these values are verified; only your recorded deposits, withdrawals, and distributions are shown.",
    );
  }
  if (input.freshness !== "FRESH") {
    disclosures.push(input.freshnessMessage);
  }

  return {
    schemaVersion: WEEKLY_STORY_SCHEMA_VERSION,
    periodKey: input.periodKey,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    headline,
    summary,
    economicImpact: {
      netChange,
      flows,
      marketChange,
      changeVerifiable: canShowChange,
      deposits,
      withdrawals,
      distributions,
      baselineAvailable: hasBaseline,
      // endValue + baselineValue are withheld together while the change is not
      // verifiable (under review / stale) so net change can never be derived as
      // (endValue − baselineValue). Recorded flows below stay visible.
      baselineValue: changeVerifiable ? baselineValue : null,
      baselinePeriodKey: changeVerifiable && hasBaseline ? input.baselinePeriodKey : null,
      endValue: changeVerifiable ? endValue : null,
    },
    pools,
    topPositive,
    topNegative,
    risk: {
      // Withheld while values are unverifiable (under review / stale) — the same
      // honesty gate as the headline change and pool valuations.
      drawdownPercent:
        changeVerifiable && input.drawdownPercent != null ? round2(input.drawdownPercent) : null,
      drawdownUsd:
        changeVerifiable && input.drawdownUsd != null ? round2(input.drawdownUsd) : null,
      elevated: elevatedDrawdown,
    },
    depositLock: {
      // lockedPrincipal + withdrawableValue == endValue, so both are withheld
      // while values are unverifiable to block account-total reconstruction.
      lockedPrincipal: changeVerifiable ? round2(input.lockedPrincipal) : null,
      withdrawableValue: changeVerifiable ? round2(input.withdrawableValue) : null,
      nextReleaseAt: input.nextReleaseAt,
      releasesNextWeek: input.lockReleasesNextWeek,
    },
    watching,
    dataQuality: {
      navStatus: input.navStatus,
      freshness: input.freshness,
      freshnessMessage: input.freshnessMessage,
      baselineAvailable: hasBaseline,
    },
    disclosures,
  };
}
