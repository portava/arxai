// Eleanor chart-read "Prepare Trade" CTA — one pure resolution of what the
// button may offer (owner screenshot 2026-10-27).
//
// The CTA used to be gated ONLY on the data/setup verdict, so for an account
// whose TRADING tile said "Blocked — Trading is restricted on your account" the
// panel still rendered "Prepare Trade" (dimmed, with a FEED tooltip) and would
// have rendered an enabled link to the trade room as soon as the verdict became
// READY_NOW. The account's resolved trading status is a separate authority: the
// link renders only when BOTH the canonical verdict can act AND trading is
// known to be ENABLED. DISPLAY-ONLY — no execution path reads this; the trade
// room re-gates every order server-side.

import type { TradingStatus } from "./scannerActionability";

export const RUBY_CTA_TRADING_BLOCKED_NOTE =
  "Trading is blocked on your account — this read is for information only.";

export interface RubyCtaInputs {
  /** `actionabilityDisplayUi(canonical).canAct`. */
  canAct: boolean;
  /** Copy of the canonical display verdict (feed/setup reason). */
  verdictCopy: string;
  /** Neutral copy for an unresolved verdict (truth still loading). */
  pendingCopy: string;
  /** The direction-aware label the verdict would use ("Prepare Buy", …). */
  verdictLabel: string;
  /** The account's resolved trading status; undefined while truth is unresolved. */
  tradingStatus: TradingStatus | null | undefined;
  /** The TRADING tile's own detail (`truth.strip.trading.detail`). */
  tradingDetail: string | null | undefined;
}

export interface RubyCtaState {
  /** Render the enabled link to the trade room. */
  showLink: boolean;
  /** Button label (neutral "Prepare Trade" whenever trading refuses). */
  label: string;
  /** Tooltip for the disabled button (null when the link renders). */
  disabledTitle: string | null;
  /** Inline note naming the account-level refusal, or null. */
  tradingNote: string | null;
}

export function resolveRubyCtaState(input: RubyCtaInputs): RubyCtaState {
  const status = input.tradingStatus ?? null;
  const detail = (input.tradingDetail ?? "").trim();
  if (status == null) {
    // Unresolved truth: never claim "blocked", never offer the link.
    return {
      showLink: false,
      label: input.verdictLabel,
      disabledTitle: input.pendingCopy,
      tradingNote: null,
    };
  }
  if (status !== "ENABLED") {
    const note =
      status === "BLOCKED"
        ? RUBY_CTA_TRADING_BLOCKED_NOTE
        : detail || "Trading isn't available on your account from here.";
    return {
      showLink: false,
      label: "Prepare Trade",
      // The governing, account-level reason first — the SAME words the TRADING
      // tile shows — never the feed copy.
      disabledTitle: detail || note,
      tradingNote: note,
    };
  }
  return input.canAct
    ? { showLink: true, label: input.verdictLabel, disabledTitle: null, tradingNote: null }
    : { showLink: false, label: input.verdictLabel, disabledTitle: input.verdictCopy, tradingNote: null };
}
