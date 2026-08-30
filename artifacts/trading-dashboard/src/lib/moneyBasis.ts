// Money-basis derivations for the cockpit and journal surfaces.
//
// THE RULE THESE ENFORCE
//   A money number must state its basis (LIVE vs DEMO/simulated, assigned vs
//   notional, broker-confirmed vs UNKNOWN) or not render at all. A failed or
//   missing read degrades to an honest typed null with a reason — never a
//   confident zero, never a reassuring default, never a silent omission.
//
// These are pure functions so the contract can be pinned by tests instead of
// living inline in JSX where a refactor can quietly re-introduce a literal.

// ── Journal win rate ───────────────────────────────────────────────────────
//
// The Trade Journal and the Win/Loss Report both computed
//   winRate = wins / entries.length
// where `entries` includes rows with no P/L and rows logged as `WAIT` (a
// no-trade OBSERVATION, not a trade). Logging a WAIT therefore dragged the
// displayed win rate down, and the Win/Loss Report printed
// "N Trades · W Wins · L Losses" with W + L < N and nothing explaining the
// gap. An entry is only DECIDED when it has a finite P/L and is an actual
// direction.

export interface JournalLikeEntry {
  pnl?: number | null;
  direction?: string | null;
}

export interface JournalStats {
  total: number;
  decided: number;
  undecided: number;
  wins: number;
  losses: number;
  /** null when nothing is decided — a win rate over zero trades is not 0%. */
  winRate: number | null;
  /** null when nothing is decided — "no data" is not "$0.00". */
  totalPnl: number | null;
}

export function isDecidedJournalEntry(e: JournalLikeEntry | null | undefined): boolean {
  if (!e) return false;
  if (typeof e.pnl !== "number" || !Number.isFinite(e.pnl)) return false;
  return String(e.direction ?? "").toUpperCase() !== "WAIT";
}

export function resolveJournalStats(entries: readonly JournalLikeEntry[]): JournalStats {
  const decided = entries.filter(isDecidedJournalEntry);
  const wins = decided.filter((e) => (e.pnl as number) > 0).length;
  const losses = decided.filter((e) => (e.pnl as number) < 0).length;
  return {
    total: entries.length,
    decided: decided.length,
    undecided: entries.length - decided.length,
    wins,
    losses,
    winRate: decided.length > 0 ? Math.round((wins / decided.length) * 100) : null,
    totalPnl: decided.length > 0 ? decided.reduce((a, e) => a + (e.pnl as number), 0) : null,
  };
}

// ── Trading Permission → Risk level row ────────────────────────────────────
//
// The row used to be `envelope?.userRiskCaps ? "Managed" : "Low"` with a
// hardcoded green class. `userRiskCaps` is a non-optional object, so the row
// was a constant: "Managed" whenever the /api/me/account-mode read SUCCEEDED,
// and a reassuring green "Low" only when it FAILED or was still loading. It
// never inspected maxLotSize, maxOpenTrades, maxDailyLossAmount,
// allowedSymbols or requireStopLoss.

export interface RiskCapsLike {
  maxLotSize?: number | null;
  maxOpenTrades?: number | null;
  maxDailyLossAmount?: number | null;
  allowedSymbols?: string[] | null;
  requireStopLoss?: boolean;
}

export type RiskLevelTone = "success" | "warning" | "unknown";

export interface RiskLevelRow {
  value: string;
  tone: RiskLevelTone;
  capsSet: number;
}

export function countRiskCaps(caps: RiskCapsLike | null | undefined): number {
  if (!caps) return 0;
  const bounded = [
    caps.maxLotSize,
    caps.maxOpenTrades,
    caps.maxDailyLossAmount,
    caps.allowedSymbols,
  ].filter((v) => v != null).length;
  return bounded + (caps.requireStopLoss ? 1 : 0);
}

export function resolveRiskLevelRow(input: {
  isError?: boolean;
  hasEnvelope: boolean;
  caps?: RiskCapsLike | null;
}): RiskLevelRow {
  // A failed or absent read is UNKNOWN. It is never rendered green, and never
  // rendered as the most reassuring value on the card.
  if (input.isError || !input.hasEnvelope || !input.caps) {
    return { value: "Unknown", tone: "unknown", capsSet: 0 };
  }
  const capsSet = countRiskCaps(input.caps);
  if (capsSet === 0) return { value: "No caps set", tone: "warning", capsSet: 0 };
  return { value: `Managed (${capsSet} cap${capsSet === 1 ? "" : "s"})`, tone: "success", capsSet };
}

// ── Trading Permission card: the WHOLE card, not just the Risk row ─────────
//
// `resolveRiskLevelRow` above fixed the Risk row, but the rest of the same
// card still asserted a permission state from no signal at all.
// `useTradingMode.fetchAccountMode` returns `null` when /api/me/account-mode
// answers !ok, and a resolved-null query is NOT an error: `isError` stays
// false, `isLoading` goes false, and `envelope` is null. Every consumer that
// read a field off the envelope therefore fell through to its default:
//
//   headline  -> `cleanUserMessage || "Your account is approved for trading."`
//                (cleanUserMessage defaults to "") — the single most
//                reassuring sentence on the card, printed when NOTHING was read
//   Blocked   -> Boolean(null) === false -> green "No"
//   Session   -> `!isLoading && !frozen` -> green "Active"
//   status    -> !canManualTrade && !blocked && !frozen -> "Waiting for
//                approval", which contradicts the headline on the same card
//
// A failed read is UNKNOWN. It is never green and never the reassuring value.

export type ReadTone = "success" | "warning" | "danger" | "unknown";

export interface PermissionRow {
  value: string;
  tone: ReadTone;
}

export interface PermissionCardState {
  /** True when no account-mode envelope was read (failed read, or loading). */
  unread: boolean;
  status: PermissionRow;
  headline: string;
  blockedRow: PermissionRow;
  sessionRow: PermissionRow;
}

export const PERMISSION_UNREAD_HEADLINE =
  "Trading permission could not be read, so this card is not a statement about your account. Reload to try again.";

export const PERMISSION_LOADING_HEADLINE = "Checking your trading permission…";

export function resolvePermissionCardState(input: {
  isLoading?: boolean;
  isError?: boolean;
  hasEnvelope: boolean;
  isFrozen?: boolean;
  canManualTrade?: boolean;
  cleanBlockedReason?: string | null;
  cleanUserMessage?: string | null;
}): PermissionCardState {
  const unread = Boolean(input.isError) || !input.hasEnvelope;

  if (unread) {
    const loading = Boolean(input.isLoading) && !input.isError;
    return {
      unread: true,
      status: { value: loading ? "Checking…" : "Unknown", tone: "unknown" },
      headline: loading ? PERMISSION_LOADING_HEADLINE : PERMISSION_UNREAD_HEADLINE,
      blockedRow: { value: "Unknown", tone: "unknown" },
      sessionRow: { value: "Unknown", tone: "unknown" },
    };
  }

  const blockedReason = input.cleanBlockedReason ?? null;
  const blocked = Boolean(blockedReason);
  const frozen = Boolean(input.isFrozen);
  const canManualTrade = Boolean(input.canManualTrade);

  const status: PermissionRow = frozen
    ? { value: "Paused", tone: "warning" }
    : blocked
      ? { value: "Trading blocked", tone: "danger" }
      : canManualTrade
        ? { value: "All clear", tone: "success" }
        : { value: "Waiting for approval", tone: "warning" };

  const headline = blocked
    ? (blockedReason as string)
    : input.cleanUserMessage
      ? input.cleanUserMessage
      : canManualTrade
        ? "Your account is approved for trading."
        : "Your account is not approved for trading yet.";

  return {
    unread: false,
    status,
    headline,
    blockedRow: blocked
      ? { value: "Yes", tone: "danger" }
      : { value: "No", tone: "success" },
    sessionRow: frozen
      ? { value: "Inactive", tone: "warning" }
      : { value: "Active", tone: "success" },
  };
}
