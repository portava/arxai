// Capability #49 — netting-effect modeling for the shared master account.
//
// In SHARED_MASTER_MT5 mode many users' orders execute on ONE broker account.
// When user A is long EURUSD 0.30 and user B is short EURUSD 0.20, the broker
// sees hedged/net exposure while ARX's per-user ledgers each carry full gross
// exposure. That divergence matters:
//   * margin at the broker is a property of the NET book, so per-user margin
//     proxies over-state (netting benefit) — a benefit that silently VANISHES
//     the moment one side closes, which can under-margin the survivors;
//   * broker-side netting/hedging rules can close or merge tickets in ways the
//     per-user attribution never asked for;
//   * one user's fill is economically the counterparty of another user's —
//     a conflict the operator must be able to SEE.
//
// This module is the pure detector: given the open per-user slices of one
// master account, it reports, per symbol, the gross/net decomposition, the
// offset (hedged) volume, and specifically whether the offset crosses users.
// Pure and deterministic: no IO, no DB, no clock.
//
// DEFAULT-DENY on malformed input: a slice with an unknown side or a
// non-finite/non-positive volume is never coerced or dropped silently — it is
// returned in `rejectedSlices` with a typed reason, and its symbol is flagged
// `hasRejectedInput: true` so a consumer can refuse to treat that symbol's
// numbers as complete.

export type MasterPositionSide = "BUY" | "SELL";

export interface MasterPositionSlice {
  /** ARX user the slice is attributed to. */
  userId: number;
  /** Broker symbol, exact string as attributed. */
  symbol: string;
  /** BUY | SELL (validated — anything else rejects the slice). */
  side: string;
  /** Open lots attributed to this user (must be finite and > 0). */
  volumeLots: number;
  /** Optional reference for journaling (attribution row id, ticket, …). */
  ref?: string | null;
}

export type SliceRejectReason =
  | "SIDE_UNKNOWN"
  | "VOLUME_NOT_FINITE"
  | "VOLUME_NOT_POSITIVE"
  | "SYMBOL_EMPTY"
  | "USER_ID_INVALID";

export interface RejectedSlice {
  slice: MasterPositionSlice;
  reason: SliceRejectReason;
}

export interface SymbolNetting {
  symbol: string;
  grossBuyLots: number;
  grossSellLots: number;
  /** grossBuy - grossSell (positive = net long). */
  netLots: number;
  /** min(grossBuy, grossSell): the volume that offsets inside the master. */
  offsetLots: number;
  /** True when ANY offset exists on this symbol. */
  offsetting: boolean;
  /**
   * True when the offset CROSSES users: at least one user is long while a
   * DIFFERENT user is short. (A single user hedging themselves is offsetting
   * but not cross-user.)
   */
  crossUserOffset: boolean;
  /** Users long / short on this symbol (sorted, unique). */
  buyUserIds: number[];
  sellUserIds: number[];
  /** Symbol's inputs included at least one rejected slice — totals INCOMPLETE. */
  hasRejectedInput: boolean;
}

export interface NettingReport {
  perSymbol: SymbolNetting[];
  /** Sum of every accepted slice's lots (gross, both sides). */
  totalGrossLots: number;
  /** Sum of |net| per symbol — what the broker book actually carries. */
  totalNetLots: number;
  /** Sum of offset lots across symbols. */
  totalOffsetLots: number;
  /** Any symbol where users offset each other. */
  crossUserOffsetDetected: boolean;
  /** Slices refused with typed reasons (never silently dropped). */
  rejectedSlices: RejectedSlice[];
}

function validateSlice(s: MasterPositionSlice): SliceRejectReason | null {
  if (!Number.isFinite(s.userId) || s.userId <= 0) return "USER_ID_INVALID";
  if (typeof s.symbol !== "string" || s.symbol.trim() === "") return "SYMBOL_EMPTY";
  if (s.side !== "BUY" && s.side !== "SELL") return "SIDE_UNKNOWN";
  if (!Number.isFinite(s.volumeLots)) return "VOLUME_NOT_FINITE";
  if (s.volumeLots <= 0) return "VOLUME_NOT_POSITIVE";
  return null;
}

/** Round to 1e-8 lots to keep float noise out of equality comparisons. */
function r8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

/**
 * Detect netting effects across the open slices of ONE master account.
 * Deterministic: output ordering is sorted by symbol; user id lists sorted
 * ascending; identical input always yields identical output.
 */
export function detectNettingEffects(
  slices: readonly MasterPositionSlice[],
): NettingReport {
  const rejectedSlices: RejectedSlice[] = [];
  const bySymbol = new Map<string, {
    buy: number; sell: number;
    buyUsers: Set<number>; sellUsers: Set<number>;
    hasRejectedInput: boolean;
  }>();

  const bucketFor = (symbol: string) => {
    let b = bySymbol.get(symbol);
    if (!b) {
      b = { buy: 0, sell: 0, buyUsers: new Set(), sellUsers: new Set(), hasRejectedInput: false };
      bySymbol.set(symbol, b);
    }
    return b;
  };

  for (const slice of slices) {
    const reason = validateSlice(slice);
    if (reason != null) {
      rejectedSlices.push({ slice, reason });
      // Flag the symbol as incomplete when we can still name it.
      if (typeof slice.symbol === "string" && slice.symbol.trim() !== "") {
        bucketFor(slice.symbol).hasRejectedInput = true;
      }
      continue;
    }
    const b = bucketFor(slice.symbol);
    if (slice.side === "BUY") {
      b.buy += slice.volumeLots;
      b.buyUsers.add(slice.userId);
    } else {
      b.sell += slice.volumeLots;
      b.sellUsers.add(slice.userId);
    }
  }

  const perSymbol: SymbolNetting[] = [...bySymbol.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([symbol, b]) => {
      const grossBuyLots = r8(b.buy);
      const grossSellLots = r8(b.sell);
      const offsetLots = r8(Math.min(grossBuyLots, grossSellLots));
      const buyUserIds = [...b.buyUsers].sort((x, y) => x - y);
      const sellUserIds = [...b.sellUsers].sort((x, y) => x - y);
      // Cross-user: some long user differs from some short user. When either
      // side has 2+ users and the other side is non-empty, or the single users
      // differ, the offset crosses users.
      const crossUserOffset =
        offsetLots > 0 &&
        buyUserIds.some((u) => sellUserIds.some((v) => v !== u));
      return {
        symbol,
        grossBuyLots,
        grossSellLots,
        netLots: r8(grossBuyLots - grossSellLots),
        offsetLots,
        offsetting: offsetLots > 0,
        crossUserOffset,
        buyUserIds,
        sellUserIds,
        hasRejectedInput: b.hasRejectedInput,
      };
    });

  return {
    perSymbol,
    totalGrossLots: r8(perSymbol.reduce((a, s) => a + s.grossBuyLots + s.grossSellLots, 0)),
    totalNetLots: r8(perSymbol.reduce((a, s) => a + Math.abs(s.netLots), 0)),
    totalOffsetLots: r8(perSymbol.reduce((a, s) => a + s.offsetLots, 0)),
    crossUserOffsetDetected: perSymbol.some((s) => s.crossUserOffset),
    rejectedSlices,
  };
}
