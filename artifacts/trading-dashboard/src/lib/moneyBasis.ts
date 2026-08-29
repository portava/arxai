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
