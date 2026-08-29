// ═══════════════════════════════════════════════════════════════════════════
// Capability #22 — Beneficial-Owner Exposure Graph (pure domain).
//
// Treats ALL accounts owned by one beneficial owner as ONE economic exposure:
// every account snapshot source the caller could read is folded into a single
// consolidated view by instrument / currency-leg / venue, with cross-account
// findings (same-direction stacking through account-splitting, cross-account
// self-hedging) surfaced explicitly.
//
// HONESTY: a source that could not be read arrives as an UNAVAILABLE account
// with a typed reason. The graph then reports coverage.complete=false and
// carries the reason forward — it NEVER synthesizes a balance, an equity or a
// position for an unreadable account.
//
// Pure: no IO. The api-server adapter (lib/portfolio/beneficialOwnerExposure)
// reads the actual snapshot sources and feeds this engine.
// ═══════════════════════════════════════════════════════════════════════════

export type AccountSnapshotStatus = "OK" | "STALE" | "UNAVAILABLE";

export interface AccountSnapshotInput {
  /** Stable key, e.g. "mt5:12345678" or "paper:default". */
  accountKey: string;
  venue: string;                       // e.g. "mt5", "deriv", "paper"
  broker?: string | null;
  currency?: string | null;
  balance?: number | null;             // null = honestly unknown
  equity?: number | null;
  accountType?: string | null;         // demo | live | real | unknown
  snapshotAtIso?: string | null;
  status: AccountSnapshotStatus;
  /** Typed reason, REQUIRED when status !== "OK" (e.g. "READ_FAILED: <msg>"). */
  statusReason?: string;
}

export interface OwnedPositionInput {
  sourceId: string;                    // row id in its source table
  source: string;                      // "trades" | "live_positions" | ...
  accountKey?: string | null;          // null = account attribution unknown
  venue: string;
  symbol: string;
  direction: "BUY" | "SELL";
  lots: number;
  riskAmount?: number | null;          // currency at risk if SL hit; null = unknown
  unrealizedPnl?: number | null;
  /** Cross-source identity (e.g. trades.id mirrored by live_positions.tradeId).
   *  Two positions with the same non-null dedupeKey are ONE economic position. */
  dedupeKey?: string | null;
}

export interface InstrumentExposure {
  instrument: string;                  // canonical symbol where resolvable
  netLots: number;                     // BUY − SELL across ALL accounts
  grossLots: number;
  grossRiskAmount: number;             // sum of known riskAmounts (unknowns excluded)
  riskAmountUnknownCount: number;      // positions whose riskAmount was null
  positions: number;
  venues: string[];
  accounts: string[];
}

export interface CrossAccountFinding {
  kind: "SAME_DIRECTION_ACROSS_ACCOUNTS" | "CROSS_ACCOUNT_HEDGE";
  instrument: string;
  accounts: string[];
  detail: string;
}

export interface BeneficialOwnerExposureGraph {
  ownerScope: "SINGLE_BENEFICIAL_OWNER";
  accounts: AccountSnapshotInput[];
  /** Combined equity over accounts whose equity is known; null when none is. */
  combinedEquity: number | null;
  combinedEquityCoverage: { known: number; unknown: number };
  byInstrument: InstrumentExposure[];
  /** Net currency legs (forex pairs decomposed), across ALL accounts. */
  byCurrencyLeg: Record<string, number>;
  byVenue: Record<string, { positions: number; grossLots: number; grossRiskAmount: number }>;
  crossAccountFindings: CrossAccountFinding[];
  totalGrossRiskAmount: number;
  totalPositions: number;
  dedupedMirrors: number;
  coverage: {
    sourcesRead: string[];
    accountsOk: number;
    accountsStale: number;
    accountsUnavailable: number;
    /** true only when every account snapshot source read cleanly. */
    complete: boolean;
    gaps: string[];                    // typed reasons carried forward verbatim
  };
  reasons: string[];
}

// Forex pair → currency legs (superset of the single-account exposure map).
const PAIR_CURRENCIES: Record<string, [string, string]> = {
  EURUSD: ["EUR", "USD"], GBPUSD: ["GBP", "USD"], AUDUSD: ["AUD", "USD"],
  NZDUSD: ["NZD", "USD"], USDJPY: ["USD", "JPY"], USDCAD: ["USD", "CAD"],
  USDCHF: ["USD", "CHF"], EURJPY: ["EUR", "JPY"], GBPJPY: ["GBP", "JPY"],
  EURGBP: ["EUR", "GBP"], AUDJPY: ["AUD", "JPY"], EURAUD: ["EUR", "AUD"],
  XAUUSD: ["XAU", "USD"], XAGUSD: ["XAG", "USD"],
};

export interface BuildExposureGraphInput {
  accounts: ReadonlyArray<AccountSnapshotInput>;
  positions: ReadonlyArray<OwnedPositionInput>;
  sourcesRead: ReadonlyArray<string>;
  /** Optional canonicalizer (e.g. resolveArxMarket). Unresolvable → raw symbol. */
  canonicalize?: (symbol: string) => string | null;
}

export function buildBeneficialOwnerExposureGraph(
  input: BuildExposureGraphInput,
): BeneficialOwnerExposureGraph {
  const reasons: string[] = [];

  // ── Dedupe cross-source mirrors: same non-null dedupeKey = one position. ──
  const seen = new Map<string, OwnedPositionInput>();
  const deduped: OwnedPositionInput[] = [];
  let dedupedMirrors = 0;
  for (const p of input.positions) {
    if (p.dedupeKey) {
      const prior = seen.get(p.dedupeKey);
      if (prior) {
        dedupedMirrors += 1;
        continue; // first source wins; mirror carries no additional exposure
      }
      seen.set(p.dedupeKey, p);
    }
    deduped.push(p);
  }
  if (dedupedMirrors > 0) {
    reasons.push(`${dedupedMirrors} mirrored position(s) deduplicated across sources (one economic position each)`);
  }

  // ── Consolidate by instrument across ALL accounts. ──
  const canon = (s: string): string => input.canonicalize?.(s) ?? s;
  const instMap = new Map<string, {
    net: number; gross: number; grossRisk: number; unknownRisk: number;
    positions: number; venues: Set<string>; accounts: Set<string>;
    dirByAccount: Map<string, Set<"BUY" | "SELL">>;
  }>();
  const currencyLegs: Record<string, number> = {};
  const byVenue: Record<string, { positions: number; grossLots: number; grossRiskAmount: number }> = {};
  let totalGrossRiskAmount = 0;

  for (const p of deduped) {
    const inst = canon(p.symbol);
    const e = instMap.get(inst) ?? {
      net: 0, gross: 0, grossRisk: 0, unknownRisk: 0, positions: 0,
      venues: new Set<string>(), accounts: new Set<string>(),
      dirByAccount: new Map<string, Set<"BUY" | "SELL">>(),
    };
    const sign = p.direction === "BUY" ? 1 : -1;
    e.net += sign * p.lots;
    e.gross += Math.abs(p.lots);
    e.positions += 1;
    if (p.riskAmount !== null && p.riskAmount !== undefined) {
      e.grossRisk += Math.max(0, p.riskAmount);
      totalGrossRiskAmount += Math.max(0, p.riskAmount);
    } else {
      e.unknownRisk += 1;
    }
    e.venues.add(p.venue);
    const acct = p.accountKey ?? `${p.venue}:unattributed`;
    e.accounts.add(acct);
    const dirs = e.dirByAccount.get(acct) ?? new Set<"BUY" | "SELL">();
    dirs.add(p.direction);
    e.dirByAccount.set(acct, dirs);
    instMap.set(inst, e);

    const pair = PAIR_CURRENCIES[p.symbol.toUpperCase()] ?? PAIR_CURRENCIES[inst.toUpperCase()];
    if (pair) {
      currencyLegs[pair[0]] = (currencyLegs[pair[0]] ?? 0) + sign * p.lots;
      currencyLegs[pair[1]] = (currencyLegs[pair[1]] ?? 0) - sign * p.lots;
    }
    const v = byVenue[p.venue] ?? { positions: 0, grossLots: 0, grossRiskAmount: 0 };
    v.positions += 1;
    v.grossLots += Math.abs(p.lots);
    v.grossRiskAmount += Math.max(0, p.riskAmount ?? 0);
    byVenue[p.venue] = v;
  }

  // ── Cross-account findings: the whole point of the single-owner view. ──
  const findings: CrossAccountFinding[] = [];
  for (const [inst, e] of instMap) {
    if (e.accounts.size < 2) continue;
    const accountDirs = [...e.dirByAccount.entries()];
    const buyAccounts = accountDirs.filter(([, d]) => d.has("BUY")).map(([a]) => a);
    const sellAccounts = accountDirs.filter(([, d]) => d.has("SELL")).map(([a]) => a);
    if (buyAccounts.length >= 2 || sellAccounts.length >= 2) {
      const dir = buyAccounts.length >= 2 ? "BUY" : "SELL";
      const accs = dir === "BUY" ? buyAccounts : sellAccounts;
      findings.push({
        kind: "SAME_DIRECTION_ACROSS_ACCOUNTS", instrument: inst, accounts: accs,
        detail: `${accs.length} accounts hold ${dir} ${inst} — account-splitting does not reduce the single-owner risk (net ${e.net.toFixed(2)} lots).`,
      });
    }
    if (buyAccounts.length >= 1 && sellAccounts.length >= 1) {
      findings.push({
        kind: "CROSS_ACCOUNT_HEDGE", instrument: inst,
        accounts: [...new Set([...buyAccounts, ...sellAccounts])],
        detail: `${inst} is held BUY and SELL across different accounts — economically flat-ish but paying double spread/financing (net ${e.net.toFixed(2)} lots).`,
      });
    }
  }

  // ── Combined equity over accounts that actually reported one. ──
  let combinedEquity: number | null = null;
  let known = 0, unknown = 0;
  for (const a of input.accounts) {
    if (a.status !== "UNAVAILABLE" && a.equity !== null && a.equity !== undefined) {
      combinedEquity = (combinedEquity ?? 0) + a.equity;
      known += 1;
    } else {
      unknown += 1;
    }
  }
  if (unknown > 0) {
    reasons.push(`combined equity covers ${known}/${input.accounts.length} account(s) — ${unknown} account(s) have no readable equity (NOT estimated)`);
  }

  const gaps: string[] = [];
  let ok = 0, stale = 0, unavailable = 0;
  for (const a of input.accounts) {
    if (a.status === "OK") ok += 1;
    else if (a.status === "STALE") { stale += 1; gaps.push(`${a.accountKey}: STALE — ${a.statusReason ?? "snapshot age unknown"}`); }
    else { unavailable += 1; gaps.push(`${a.accountKey}: UNAVAILABLE — ${a.statusReason ?? "unspecified"}`); }
  }
  const complete = unavailable === 0 && stale === 0;
  if (!complete) reasons.push(`exposure graph is PARTIAL: ${gaps.length} account gap(s) — treat consolidated numbers as a lower bound`);

  const byInstrument: InstrumentExposure[] = [...instMap.entries()]
    .map(([instrument, e]) => ({
      instrument, netLots: e.net, grossLots: e.gross,
      grossRiskAmount: e.grossRisk, riskAmountUnknownCount: e.unknownRisk,
      positions: e.positions,
      venues: [...e.venues].sort(), accounts: [...e.accounts].sort(),
    }))
    .sort((a, b) => b.grossLots - a.grossLots || a.instrument.localeCompare(b.instrument));

  return {
    ownerScope: "SINGLE_BENEFICIAL_OWNER",
    accounts: [...input.accounts],
    combinedEquity,
    combinedEquityCoverage: { known, unknown },
    byInstrument,
    byCurrencyLeg: currencyLegs,
    byVenue,
    crossAccountFindings: findings,
    totalGrossRiskAmount,
    totalPositions: deduped.length,
    dedupedMirrors,
    coverage: {
      sourcesRead: [...input.sourcesRead],
      accountsOk: ok, accountsStale: stale, accountsUnavailable: unavailable,
      complete, gaps,
    },
    reasons,
  };
}

/** Compact summary the Admission Controller (#21) consumes. */
export interface ConsolidatedExposureSummary {
  byVenueRiskAmount: Record<string, number>;
  byInstrumentNetLots: Record<string, number>;
  totalGrossRiskAmount: number;
  totalPositions: number;
  combinedEquity: number | null;
  coverageComplete: boolean;
  coverageGaps: string[];
}

export function summarizeExposureForAdmission(
  graph: BeneficialOwnerExposureGraph,
): ConsolidatedExposureSummary {
  const byVenueRiskAmount: Record<string, number> = {};
  for (const [v, x] of Object.entries(graph.byVenue)) byVenueRiskAmount[v] = x.grossRiskAmount;
  const byInstrumentNetLots: Record<string, number> = {};
  for (const i of graph.byInstrument) byInstrumentNetLots[i.instrument] = i.netLots;
  return {
    byVenueRiskAmount, byInstrumentNetLots,
    totalGrossRiskAmount: graph.totalGrossRiskAmount,
    totalPositions: graph.totalPositions,
    combinedEquity: graph.combinedEquity,
    coverageComplete: graph.coverage.complete,
    coverageGaps: graph.coverage.gaps,
  };
}
