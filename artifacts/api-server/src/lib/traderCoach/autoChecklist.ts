// Pre-session checklist — the "auto-checked" items and how they are answered.
//
// Kept in its own module (no database imports) so the evaluator can be unit
// tested in the offline CI lane.

/**
 * A pre-session checklist item.
 *
 * `auto: true` means the system can answer this item itself. It used to mean
 * only that the UI should DISABLE the checkbox — so the five safety items the
 * user was told were "auto-checked" rendered permanently unchecked and
 * un-clickable, and nothing anywhere evaluated them. `autoResult` is the actual
 * answer, and `NOT_CHECKED` is a real state: it is returned when the Risk
 * Governor could not be read, and must never be shown as a pass.
 */
export type AutoCheckResult = "PASS" | "FAIL" | "NOT_CHECKED";

export interface PreSessionChecklistItem {
  id: string;
  label: string;
  required: boolean;
  auto?: boolean;
  /** Present only when `auto` is true. */
  autoResult?: AutoCheckResult;
  /** Why the auto item resolved the way it did. */
  autoDetail?: string;
}

/** The Risk Governor facts each auto item is answered from. */
export interface AutoCheckGovernorView {
  overallStatus: string;
  hardBlocks: Array<{ code: string; message: string }>;
  riskFlags: Array<{ code: string; message: string }>;
  cooldowns: Array<{ symbol: string; reason: string | null; until: string | null }>;
}

/**
 * Answer every `auto: true` checklist item from the Risk Governor read.
 *
 * Fails CLOSED: with no governor read, every auto item is NOT_CHECKED — never
 * a pass. "Not being able to read the stop button is not permission to trade."
 */
export function evaluateAutoChecklist(
  items: PreSessionChecklistItem[],
  governor: AutoCheckGovernorView | null,
): PreSessionChecklistItem[] {
  const has = (code: string) =>
    governor?.hardBlocks.some((b) => b.code === code) ??
    false;
  const flagged = (code: string) => governor?.riskFlags.some((f) => f.code === code) ?? false;

  return items.map((item) => {
    if (!item.auto) return { ...item };
    if (!governor) {
      return {
        ...item,
        autoResult: "NOT_CHECKED" as const,
        autoDetail: "Risk Governor could not be read — this item is unverified, not passed.",
      };
    }
    switch (item.id) {
      case "governor_ok":
        return governor.overallStatus === "LOCKED"
          ? { ...item, autoResult: "FAIL" as const, autoDetail: "Risk Governor is LOCKED." }
          : { ...item, autoResult: "PASS" as const, autoDetail: `Risk Governor status: ${governor.overallStatus}.` };
      case "daily_loss_ok":
        return has("DAILY_LOSS_LIMIT_EXCEEDED")
          ? { ...item, autoResult: "FAIL" as const, autoDetail: "Daily paper loss limit is exceeded." }
          : { ...item, autoResult: "PASS" as const, autoDetail: "Daily paper loss limit not hit." };
      case "no_cooldown": {
        const n = governor.cooldowns.length;
        return n > 0
          ? { ...item, autoResult: "FAIL" as const, autoDetail: `${n} active symbol cooldown(s): ${governor.cooldowns.map((c) => c.symbol).join(", ")}.` }
          : { ...item, autoResult: "PASS" as const, autoDetail: "No active symbol cooldowns." };
      }
      case "data_quality":
        if (has("MARKET_DATA_FAILED")) {
          return { ...item, autoResult: "FAIL" as const, autoDetail: "Market data is unavailable." };
        }
        if (flagged("MARKET_DATA_FALLBACK_ONLY")) {
          return { ...item, autoResult: "FAIL" as const, autoDetail: "Market data is fallback-only." };
        }
        return { ...item, autoResult: "PASS" as const, autoDetail: "Market data quality is acceptable." };
      case "live_disabled":
        return has("LIVE_TRADING_FLAG_DETECTED") || has("LIVE_CAN_PLACE_TRADES_TRUE")
          ? { ...item, autoResult: "FAIL" as const, autoDetail: "A live-trading flag is set — Build HH locks the system." }
          : { ...item, autoResult: "PASS" as const, autoDetail: "No live-trading flag detected." };
      case "paper_only":
        return has("MARKET_DATA_MODE_NOT_READ_ONLY")
          ? { ...item, autoResult: "FAIL" as const, autoDetail: "MARKET_DATA_MODE is not read_only." }
          : { ...item, autoResult: "PASS" as const, autoDetail: "Mode is paper-only." };
      default:
        // An auto item with no evaluator is unverified, not passing.
        return {
          ...item,
          autoResult: "NOT_CHECKED" as const,
          autoDetail: "No automatic check is implemented for this item.",
        };
    }
  });
}

