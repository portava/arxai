// Pre-trade Risk Governor — the one authority for the 12 mandatory risk rules.
//
// Every path that can open, close or modify a position (Trade Action Center,
// Ruby drafts, paper automation, manual demo orders, the demo MT5 queue and
// the live command pipeline) hands a TradeIntent to `enforcePreTradeRisk`
// (./enforce.ts), which loads a RiskContext and calls `evaluatePreTradeRisk`
// below. Nothing here can be relaxed by the caller: the limits come from
// `resolveEffectiveLimits` (strictest of every stored limit wins) and the
// caller only supplies facts (prices, positions, account).
//
// This file is PURE: no DB, no clock reads (ctx.now), no I/O. Every rule is
// evaluated on every call — not first-fail — so the audit row records the
// full picture and combinations of breaches are visible.
//
// Fail-safe: when a fact a rule needs is missing (no quote, unknown contract
// size, unknown equity, no stop on an open position) the rule BLOCKS new risk
// rather than guessing. Risk-reducing actions (CLOSE / PARTIAL_CLOSE) are only
// held back by an invalid quantity or a disconnected broker, so the governor
// never traps open exposure.

export type RiskVenue = "PAPER" | "DEMO" | "LIVE";
export type IntentOrigin = "manual" | "ruby" | "automation" | "strategy" | "api" | "system";
export type IntentAction = "OPEN" | "CLOSE" | "PARTIAL_CLOSE" | "MODIFY";

export interface TradeIntent {
  userId: number;
  venue: RiskVenue;
  origin: IntentOrigin;
  action: IntentAction;
  symbol: string;
  side: "BUY" | "SELL" | null;
  lots: number | null;
  /** Limit / stop price for a pending order; null or absent = market. */
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  /** Caller's own row for this intent ("trade_action:12"), excluded from the duplicate scan. */
  intentRef?: string | null;
  /**
   * MODIFY only: the position being changed (its entry and current stop), so
   * a tightened stop can be told apart from a widened or removed one.
   */
  position?: { entryPrice: number; stopLoss: number | null } | null;
}

export const RISK_RULE_IDS = [
  "max_position_size",
  "max_portfolio_exposure",
  "buying_power",
  "leverage",
  "concentration",
  "stop_loss_required",
  "daily_loss_limit",
  "per_trade_loss_limit",
  "duplicate_or_conflicting",
  "stale_market_data",
  "invalid_price_quantity",
  "broker_unavailable",
] as const;
export type RiskRuleId = (typeof RISK_RULE_IDS)[number];

// Platform ceilings. A stored user/admin limit can only make these stricter.
export const PLATFORM_RISK_CEILINGS = {
  maxLotSize: 5,                 // same hard cap the Trade Action guard has always applied
  maxLeverage: 30,               // gross notional / equity
  maxSymbolLeverage: 15,         // one symbol's notional / equity
  maxPositionsPerSymbol: 2,
  maxPortfolioRiskPercent: 10,   // open loss-at-stop across all positions / equity
  maxQuoteAgeMs: 60_000,         // same budget as MT5_FEED_FRESH_MS
  duplicateWindowMs: 60_000,
  maxStopDistanceFraction: 0.5,  // a stop 50% away from price is a typo, not a plan
  maxLimitDeviationFraction: 0.2,
  defaultVolumeStep: 0.01,
} as const;

export interface EffectiveLimits {
  maxLotSize: number;
  maxRiskPerTradePercent: number;
  maxRiskPerTradeAmount: number | null;
  /** null = the user switched daily-loss blocking off and no admin cap applies. */
  maxDailyLossPercent: number | null;
  maxDailyLossAmount: number | null;
  requireStopLoss: boolean;
  maxPortfolioRiskPercent: number;
  maxLeverage: number;
  maxSymbolLeverage: number;
  maxPositionsPerSymbol: number;
  maxQuoteAgeMs: number;
  duplicateWindowMs: number;
  /** Which stored value won for each limit, for the audit row. */
  sources: Record<string, string>;
}

export interface StoredLimitRows {
  /** user_risk_settings (the trader's Risk Governor page). */
  userSettings?: {
    maxRiskPerTradePercent: number;
    maxRiskPerTradeAmount: number | null;
    maxDailyLossPercent: number;
    maxDailyLossAmount: number | null;
    maxOpenTrades: number;
    maxPositionSize: number | null;
    blockAfterDailyLossHit: boolean;
    requireStopLoss: boolean;
  } | null;
  /** risk_settings (legacy per-user limits page). */
  legacySettings?: {
    maxDailyLossPct: number;
    maxLotSize: number;
    riskPerTradePct: number;
    maxOpenTrades: number;
  } | null;
  /** user_risk_limits (admin-set hard limits). */
  adminLimits?: {
    maxLotSize: number;
    maxDailyLossUsd: number;
  } | null;
}

// Defaults when the trader never saved a settings row — the same column
// defaults user_risk_settings ships with.
const USER_DEFAULTS = {
  maxRiskPerTradePercent: 1,
  maxDailyLossPercent: 3,
  maxOpenTrades: 3,
  requireStopLoss: true,
  blockAfterDailyLossHit: true,
} as const;

function strictest(
  candidates: Array<[string, number | null | undefined]>,
): { value: number | null; source: string } {
  let best: { value: number | null; source: string } = { value: null, source: "none" };
  for (const [source, v] of candidates) {
    if (v == null || !Number.isFinite(v) || v <= 0) continue;
    if (best.value == null || v < best.value) best = { value: v, source };
  }
  return best;
}

/** Strictest of every stored limit wins; platform ceilings bound all of them. */
export function resolveEffectiveLimits(rows: StoredLimitRows): EffectiveLimits {
  const u = rows.userSettings ?? null;
  const l = rows.legacySettings ?? null;
  const a = rows.adminLimits ?? null;
  const sources: Record<string, string> = {};

  const lot = strictest([
    ["platform", PLATFORM_RISK_CEILINGS.maxLotSize],
    ["user_risk_settings.max_position_size", u?.maxPositionSize],
    ["risk_settings.max_lot_size", l?.maxLotSize],
    ["user_risk_limits.max_lot_size", a?.maxLotSize],
  ]);
  sources["maxLotSize"] = lot.source;

  const perTradePct = strictest([
    ["user_risk_settings.max_risk_per_trade_percent", u ? u.maxRiskPerTradePercent : USER_DEFAULTS.maxRiskPerTradePercent],
    ["risk_settings.risk_per_trade_pct", l?.riskPerTradePct],
  ]);
  sources["maxRiskPerTradePercent"] = u ? perTradePct.source : `default:${perTradePct.source}`;

  const perTradeAmt = strictest([["user_risk_settings.max_risk_per_trade_amount", u?.maxRiskPerTradeAmount]]);
  sources["maxRiskPerTradeAmount"] = perTradeAmt.source;

  // The trader may switch their own daily-loss block off; an admin USD cap
  // still applies regardless.
  const userDailyOn = u ? u.blockAfterDailyLossHit : USER_DEFAULTS.blockAfterDailyLossHit;
  const dailyPct = userDailyOn
    ? strictest([
        ["user_risk_settings.max_daily_loss_percent", u ? u.maxDailyLossPercent : USER_DEFAULTS.maxDailyLossPercent],
        ["risk_settings.max_daily_loss_pct", l?.maxDailyLossPct],
      ])
    : { value: null, source: "disabled_by_user" };
  sources["maxDailyLossPercent"] = dailyPct.source;
  const dailyAmt = strictest([
    ["user_risk_settings.max_daily_loss_amount", userDailyOn ? u?.maxDailyLossAmount : null],
    ["user_risk_limits.max_daily_loss_usd", a?.maxDailyLossUsd],
  ]);
  sources["maxDailyLossAmount"] = dailyAmt.source;

  // Portfolio heat derives from the trader's own settings: per-trade risk
  // times the number of trades they allow open at once.
  const maxOpen = Math.min(
    u ? u.maxOpenTrades : USER_DEFAULTS.maxOpenTrades,
    l?.maxOpenTrades && l.maxOpenTrades > 0 ? l.maxOpenTrades : Number.POSITIVE_INFINITY,
  );
  const perTrade = perTradePct.value ?? USER_DEFAULTS.maxRiskPerTradePercent;
  const portfolio = Math.min(PLATFORM_RISK_CEILINGS.maxPortfolioRiskPercent, perTrade * Math.max(1, maxOpen));
  sources["maxPortfolioRiskPercent"] = portfolio === PLATFORM_RISK_CEILINGS.maxPortfolioRiskPercent
    ? "platform" : "per_trade_percent x max_open_trades";

  return {
    maxLotSize: lot.value ?? PLATFORM_RISK_CEILINGS.maxLotSize,
    maxRiskPerTradePercent: perTrade,
    maxRiskPerTradeAmount: perTradeAmt.value,
    maxDailyLossPercent: dailyPct.value,
    maxDailyLossAmount: dailyAmt.value,
    requireStopLoss: u ? u.requireStopLoss : USER_DEFAULTS.requireStopLoss,
    maxPortfolioRiskPercent: portfolio,
    maxLeverage: PLATFORM_RISK_CEILINGS.maxLeverage,
    maxSymbolLeverage: PLATFORM_RISK_CEILINGS.maxSymbolLeverage,
    maxPositionsPerSymbol: PLATFORM_RISK_CEILINGS.maxPositionsPerSymbol,
    maxQuoteAgeMs: PLATFORM_RISK_CEILINGS.maxQuoteAgeMs,
    duplicateWindowMs: PLATFORM_RISK_CEILINGS.duplicateWindowMs,
    sources,
  };
}

export interface RiskAccount {
  equity: number | null;
  freeMargin: number | null;
  /** Account leverage (e.g. 100 for 1:100). null = unknown; the platform ceiling is used. */
  leverage: number | null;
  currency: string;
  source: string;
}

export interface InstrumentModel {
  /** Units per 1.00 lot. null = unknown, and money-based rules block. */
  contractSize: number | null;
  /** Profit currency → account currency. null = no rate, and money-based rules block. */
  quoteToAccountFx: number | null;
  volumeStep: number | null;
  minVolume: number | null;
  maxVolume: number | null;
  source: string;
}

export interface RiskQuote {
  bid: number | null;
  ask: number | null;
  at: Date | null;
  source: string;
}

export interface RiskPosition {
  symbol: string;
  side: "BUY" | "SELL";
  lots: number;
  entryPrice: number;
  stopLoss: number | null;
}

export interface RiskInFlight {
  ref: string;
  symbol: string;
  side: "BUY" | "SELL";
  lots: number;
  at: Date;
  /** "pending" = queued / awaiting the broker; "filled" = opened within the window. */
  kind: "pending" | "filled";
}

export type BrokerStatus = "CONNECTED" | "DEGRADED" | "DISCONNECTED";

export interface RiskContext {
  now: Date;
  limits: EffectiveLimits;
  account: RiskAccount | null;
  /** Instrument model per symbol; must cover the intent's symbol and every open position. */
  instruments: Record<string, InstrumentModel>;
  quote: RiskQuote | null;
  positions: RiskPosition[];
  inFlight: RiskInFlight[];
  broker: { status: BrokerStatus; lastSeenAt: Date | null; detail: string };
  daily: { realizedPnl: number | null; floatingPnl: number | null };
}

export type RuleOutcome = "PASS" | "BLOCK" | "NOT_APPLICABLE";

export interface RiskRuleResult {
  rule: RiskRuleId;
  outcome: RuleOutcome;
  reason: string | null;
  measured?: Record<string, number | string | boolean | null>;
}

export interface RiskDecision {
  decision: "ALLOW" | "BLOCK";
  blockedBy: RiskRuleId[];
  primaryReason: string | null;
  rules: RiskRuleResult[];
  evaluatedAt: string;
}

const round = (n: number, dp = 2) => Number(n.toFixed(dp));

function moneyPerPriceUnit(lots: number, inst: InstrumentModel | undefined): number | null {
  if (!inst || inst.contractSize == null || inst.quoteToAccountFx == null) return null;
  return lots * inst.contractSize * inst.quoteToAccountFx;
}

export function evaluatePreTradeRisk(intent: TradeIntent, ctx: RiskContext): RiskDecision {
  const L = ctx.limits;
  const results = new Map<RiskRuleId, RiskRuleResult>();
  const set = (rule: RiskRuleId, outcome: RuleOutcome, reason: string | null, measured?: RiskRuleResult["measured"]) => {
    results.set(rule, { rule, outcome, reason, measured });
  };
  const na = (rule: RiskRuleId, why: string) => set(rule, "NOT_APPLICABLE", null, { why });

  const opens = intent.action === "OPEN";
  const reduces = intent.action === "CLOSE" || intent.action === "PARTIAL_CLOSE";
  const lots = intent.lots;
  const sl = intent.stopLoss ?? null;
  const tp = intent.takeProfit ?? null;
  const q = ctx.quote;
  const quoteRef = q && intent.side
    ? (intent.side === "BUY" ? q.ask : q.bid)
    : null;
  const validQuoteRef = quoteRef != null && Number.isFinite(quoteRef) && quoteRef > 0 ? quoteRef : null;
  const ref = intent.entryPrice != null && Number.isFinite(intent.entryPrice) && intent.entryPrice > 0
    ? intent.entryPrice
    : validQuoteRef;

  // ── 11. Invalid price / quantity ────────────────────────────────────────
  {
    const problems: string[] = [];
    const inst = ctx.instruments[intent.symbol];
    const step = inst?.volumeStep && inst.volumeStep > 0 ? inst.volumeStep : PLATFORM_RISK_CEILINGS.defaultVolumeStep;
    if (opens || reduces) {
      if (lots == null || !Number.isFinite(lots) || lots <= 0) problems.push(`quantity ${lots} is not a positive number`);
      else {
        const steps = lots / step;
        if (Math.abs(steps - Math.round(steps)) > 1e-6) problems.push(`quantity ${lots} is not a multiple of the ${step} lot step`);
        if (opens && inst?.minVolume != null && lots < inst.minVolume) problems.push(`quantity ${lots} is below the broker minimum ${inst.minVolume}`);
      }
    } else if (lots != null && (!Number.isFinite(lots) || lots <= 0)) {
      problems.push(`quantity ${lots} is not a positive number`);
    }
    if (opens && intent.side !== "BUY" && intent.side !== "SELL") problems.push("side must be BUY or SELL");
    if (intent.entryPrice != null && (!Number.isFinite(intent.entryPrice) || intent.entryPrice <= 0)) {
      problems.push(`entry price ${intent.entryPrice} is not a positive number`);
    }
    if (sl != null && (!Number.isFinite(sl) || sl <= 0)) problems.push(`stop loss ${sl} is not a positive number`);
    if (tp != null && (!Number.isFinite(tp) || tp <= 0)) problems.push(`take profit ${tp} is not a positive number`);
    if ((opens || intent.action === "MODIFY") && ref != null && intent.side) {
      if (sl != null && sl > 0) {
        if (intent.side === "BUY" && sl >= ref) problems.push(`BUY stop ${sl} must be below price ${ref}`);
        if (intent.side === "SELL" && sl <= ref) problems.push(`SELL stop ${sl} must be above price ${ref}`);
        if (Math.abs(sl - ref) / ref > PLATFORM_RISK_CEILINGS.maxStopDistanceFraction) {
          problems.push(`stop ${sl} is more than ${PLATFORM_RISK_CEILINGS.maxStopDistanceFraction * 100}% from price ${ref}`);
        }
      }
      if (tp != null && tp > 0) {
        if (intent.side === "BUY" && tp <= ref) problems.push(`BUY take profit ${tp} must be above price ${ref}`);
        if (intent.side === "SELL" && tp >= ref) problems.push(`SELL take profit ${tp} must be below price ${ref}`);
      }
    }
    if (opens && intent.entryPrice != null && validQuoteRef != null
        && Math.abs(intent.entryPrice - validQuoteRef) / validQuoteRef > PLATFORM_RISK_CEILINGS.maxLimitDeviationFraction) {
      problems.push(`order price ${intent.entryPrice} is more than ${PLATFORM_RISK_CEILINGS.maxLimitDeviationFraction * 100}% from market ${validQuoteRef}`);
    }
    if (problems.length) set("invalid_price_quantity", "BLOCK", `Invalid order: ${problems[0]}.`, { problems: problems.join("; ") });
    else set("invalid_price_quantity", "PASS", null);
  }

  // ── 12. Disconnected / degraded broker ─────────────────────────────────
  {
    const b = ctx.broker;
    const measured = { status: b.status, lastSeenAt: b.lastSeenAt?.toISOString() ?? null, detail: b.detail };
    if (b.status === "DISCONNECTED") {
      set("broker_unavailable", "BLOCK", `Broker is disconnected (${b.detail}). No order can be sent.`, measured);
    } else if (b.status === "DEGRADED" && !reduces) {
      set("broker_unavailable", "BLOCK", `Broker connection is degraded (${b.detail}). New risk is paused; closing is still allowed.`, measured);
    } else {
      set("broker_unavailable", "PASS", null, measured);
    }
  }

  if (reduces) {
    for (const r of RISK_RULE_IDS) if (!results.has(r)) na(r, "risk-reducing action");
    return finish(results, ctx);
  }

  // ── 6. Stop-loss requirement ───────────────────────────────────────────
  if (L.requireStopLoss) {
    if (sl == null) {
      set("stop_loss_required", "BLOCK",
        intent.action === "MODIFY" ? "A stop loss is required; it cannot be removed." : "A stop loss is required for every new trade.",
        { requireStopLoss: true });
    } else set("stop_loss_required", "PASS", null, { requireStopLoss: true });
  } else set("stop_loss_required", "PASS", null, { requireStopLoss: false });

  if (intent.action === "MODIFY") {
    // Position Guardian invariant: an automated action (Ruby, a strategy,
    // automation) may only tighten a stop. A trader may widen it by hand, but
    // never past their per-trade loss limit.
    const pos = intent.position ?? null;
    if (!pos && intent.origin !== "manual" && results.get("stop_loss_required")?.outcome !== "BLOCK") {
      set("stop_loss_required", "BLOCK",
        `The position ${intent.origin} is modifying could not be found, so the change cannot be proven to only tighten the stop.`,
        { origin: intent.origin });
    }
    if (pos && pos.stopLoss != null && pos.stopLoss > 0 && intent.side) {
      const widened = sl == null
        || (intent.side === "BUY" ? sl < pos.stopLoss - 1e-12 : sl > pos.stopLoss + 1e-12);
      if (widened) {
        const measured = { currentStopLoss: pos.stopLoss, newStopLoss: sl, origin: intent.origin };
        if (intent.origin !== "manual" && results.get("stop_loss_required")?.outcome !== "BLOCK") {
          set("stop_loss_required", "BLOCK",
            `Automated actions may only tighten a stop: ${intent.origin} tried to move it from ${pos.stopLoss} to ${sl ?? "none"}.`,
            measured);
        }
        if (sl != null) {
          const perUnit = lots != null && lots > 0 ? moneyPerPriceUnit(lots, ctx.instruments[intent.symbol]) : null;
          const equity = ctx.account?.equity != null && ctx.account.equity > 0 ? ctx.account.equity : null;
          const pctCap = equity != null ? (equity * L.maxRiskPerTradePercent) / 100 : null;
          const cap = [pctCap, L.maxRiskPerTradeAmount].filter((v): v is number => v != null)
            .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
          const loss = perUnit != null ? Math.abs(pos.entryPrice - sl) * perUnit : null;
          if (loss == null || !Number.isFinite(cap)) {
            set("per_trade_loss_limit", "BLOCK", "A widened stop cannot be checked against your per-trade limit (position size or equity unknown).", measured);
          } else if (loss > cap + 1e-9) {
            set("per_trade_loss_limit", "BLOCK",
              `Moving the stop to ${sl} puts ${round(loss)} at risk, above your per-trade limit of ${round(cap)}.`,
              { ...measured, lossAtStop: round(loss), cap: round(cap) });
          } else set("per_trade_loss_limit", "PASS", null, { ...measured, lossAtStop: round(loss), cap: round(cap) });
        }
      }
    }
    for (const r of RISK_RULE_IDS) if (!results.has(r)) na(r, "modify does not add exposure");
    return finish(results, ctx);
  }

  // From here on: OPEN (adds risk).

  // ── 10. Stale market data ──────────────────────────────────────────────
  {
    if (!q) set("stale_market_data", "BLOCK", `No market quote for ${intent.symbol}. Trade blocked until a fresh price arrives.`);
    else if (validQuoteRef == null || (q.bid != null && q.ask != null && q.ask < q.bid)) {
      set("stale_market_data", "BLOCK", `Quote for ${intent.symbol} is unusable (bid ${q.bid}, ask ${q.ask}).`, { source: q.source });
    } else if (!q.at) {
      set("stale_market_data", "BLOCK", `Quote for ${intent.symbol} has no timestamp, so its age cannot be proven.`, { source: q.source });
    } else {
      const ageMs = ctx.now.getTime() - q.at.getTime();
      const measured = { ageMs, maxAgeMs: L.maxQuoteAgeMs, source: q.source };
      if (ageMs > L.maxQuoteAgeMs) {
        set("stale_market_data", "BLOCK", `Quote for ${intent.symbol} is ${Math.round(ageMs / 1000)}s old (limit ${L.maxQuoteAgeMs / 1000}s).`, measured);
      } else set("stale_market_data", "PASS", null, measured);
    }
  }

  // ── 1. Maximum position size ───────────────────────────────────────────
  {
    const inst = ctx.instruments[intent.symbol];
    const brokerMax = inst?.maxVolume != null && inst.maxVolume > 0 ? inst.maxVolume : null;
    const cap = brokerMax != null ? Math.min(L.maxLotSize, brokerMax) : L.maxLotSize;
    const measured = { lots, maxLotSize: cap, source: brokerMax != null && brokerMax < L.maxLotSize ? "broker_max_volume" : L.sources["maxLotSize"] ?? "platform" };
    if (lots != null && lots > cap) set("max_position_size", "BLOCK", `Lot size ${lots} exceeds your maximum of ${cap}.`, measured);
    else set("max_position_size", "PASS", null, measured);
  }

  // ── 9. Duplicate / conflicting orders ──────────────────────────────────
  {
    const sym = intent.symbol;
    const windowStart = ctx.now.getTime() - L.duplicateWindowMs;
    const others = ctx.inFlight.filter((f) => f.ref !== intent.intentRef);
    const dup = others.find((f) => f.symbol === sym && f.side === intent.side && lots != null
      && Math.abs(f.lots - lots) < 1e-9 && (f.kind === "pending" || f.at.getTime() >= windowStart));
    const opposite = intent.side === "BUY" ? "SELL" : "BUY";
    const conflictPos = ctx.positions.find((p) => p.symbol === sym && p.side === opposite);
    const conflictOrder = others.find((f) => f.symbol === sym && f.side === opposite && f.kind === "pending");
    if (dup) {
      set("duplicate_or_conflicting", "BLOCK",
        `An identical ${intent.side} ${lots} ${sym} order (${dup.ref}) ${dup.kind === "pending" ? "is already in flight" : "was just filled"}.`,
        { duplicateOf: dup.ref });
    } else if (conflictPos || conflictOrder) {
      set("duplicate_or_conflicting", "BLOCK",
        `This ${intent.side} conflicts with an open ${opposite} on ${sym}. Close it first instead of hedging.`,
        { conflictsWith: conflictOrder?.ref ?? `position:${sym}:${opposite}` });
    } else set("duplicate_or_conflicting", "PASS", null);
  }

  // Money-based rules share these facts.
  const inst = ctx.instruments[intent.symbol];
  const perUnit = lots != null && lots > 0 ? moneyPerPriceUnit(lots, inst) : null;
  const equity = ctx.account?.equity != null && ctx.account.equity > 0 ? ctx.account.equity : null;
  const newNotional = perUnit != null && ref != null ? perUnit * ref : null;
  const newLossAtStop = perUnit != null && ref != null && sl != null && sl > 0 ? Math.abs(ref - sl) * perUnit : null;
  const sizingGap = !inst || inst.contractSize == null
    ? `contract size for ${intent.symbol} is unknown`
    : inst.quoteToAccountFx == null
      ? `no rate converts ${intent.symbol} P/L into ${ctx.account?.currency ?? "the account currency"}`
      : ref == null ? `no price for ${intent.symbol}` : null;

  const positionMoney = ctx.positions.map((p) => {
    const pu = moneyPerPriceUnit(p.lots, ctx.instruments[p.symbol]);
    return {
      p,
      notional: pu != null ? pu * p.entryPrice : null,
      lossAtStop: pu != null && p.stopLoss != null && p.stopLoss > 0 ? Math.abs(p.entryPrice - p.stopLoss) * pu : null,
    };
  });

  // ── 8. Per-trade loss limit ────────────────────────────────────────────
  {
    const pctCap = equity != null ? (equity * L.maxRiskPerTradePercent) / 100 : null;
    const cap = [pctCap, L.maxRiskPerTradeAmount].filter((v): v is number => v != null).reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
    const measured = {
      lossAtStop: newLossAtStop != null ? round(newLossAtStop) : null,
      maxRiskPerTradePercent: L.maxRiskPerTradePercent,
      maxRiskPerTradeAmount: L.maxRiskPerTradeAmount,
      equity,
    };
    if (sl == null) set("per_trade_loss_limit", "BLOCK", "Without a stop loss the loss on this trade is unbounded.", measured);
    else if (sizingGap) set("per_trade_loss_limit", "BLOCK", `Cannot measure the loss at stop: ${sizingGap}.`, measured);
    else if (equity == null && L.maxRiskPerTradeAmount == null) set("per_trade_loss_limit", "BLOCK", "Account equity is unknown, so per-trade risk cannot be checked.", measured);
    else if (newLossAtStop! > cap + 1e-9) {
      set("per_trade_loss_limit", "BLOCK",
        `Loss at stop ${round(newLossAtStop!)} exceeds your per-trade limit of ${round(cap)}.`, measured);
    } else set("per_trade_loss_limit", "PASS", null, measured);
  }

  // ── 7. Daily loss limit ────────────────────────────────────────────────
  {
    const realized = ctx.daily.realizedPnl;
    const floatingLoss = ctx.daily.floatingPnl != null && ctx.daily.floatingPnl < 0 ? ctx.daily.floatingPnl : 0;
    const measured: RiskRuleResult["measured"] = {
      realizedPnl: realized, floatingPnl: ctx.daily.floatingPnl,
      maxDailyLossPercent: L.maxDailyLossPercent, maxDailyLossAmount: L.maxDailyLossAmount, equity,
    };
    if (L.maxDailyLossPercent == null && L.maxDailyLossAmount == null) {
      set("daily_loss_limit", "PASS", null, { ...measured, note: "no daily cap configured" });
    } else if (realized == null) {
      set("daily_loss_limit", "BLOCK", "Today's realized P/L could not be computed, so the daily loss limit cannot be checked.", measured);
    } else {
      const combined = realized + floatingLoss;
      measured["combinedPnl"] = round(combined);
      let reason: string | null = null;
      if (L.maxDailyLossAmount != null && combined <= -L.maxDailyLossAmount) {
        reason = `Daily loss ${round(-combined)} reached the ${L.maxDailyLossAmount} cap. New trades are blocked until tomorrow; closing is allowed.`;
      } else if (L.maxDailyLossPercent != null && combined < 0) {
        if (equity == null) reason = "Account equity is unknown, so the daily loss percentage cannot be checked.";
        else {
          const pct = (-combined / equity) * 100;
          measured["lossPercent"] = round(pct);
          if (pct >= L.maxDailyLossPercent) {
            reason = `Daily loss ${round(pct)}% reached the ${L.maxDailyLossPercent}% cap. New trades are blocked until tomorrow; closing is allowed.`;
          }
        }
      }
      set("daily_loss_limit", reason ? "BLOCK" : "PASS", reason, measured);
    }
  }

  // ── 2. Maximum portfolio exposure (open loss-at-stop) ──────────────────
  {
    const unbounded = positionMoney.find((m) => m.lossAtStop == null);
    const openRisk = positionMoney.reduce((s, m) => s + (m.lossAtStop ?? 0), 0);
    const cap = equity != null ? (equity * L.maxPortfolioRiskPercent) / 100 : null;
    const measured = {
      openRisk: round(openRisk), newRisk: newLossAtStop != null ? round(newLossAtStop) : null,
      cap: cap != null ? round(cap) : null, maxPortfolioRiskPercent: L.maxPortfolioRiskPercent,
    };
    if (unbounded) {
      set("max_portfolio_exposure", "BLOCK",
        `Your open ${unbounded.p.side} ${unbounded.p.symbol} has ${unbounded.p.stopLoss == null ? "no stop" : "an unmeasurable size"}, so total exposure is unbounded. Add a stop before opening more.`,
        measured);
    } else if (newLossAtStop == null || cap == null) {
      set("max_portfolio_exposure", "BLOCK", `Cannot measure portfolio exposure: ${sizingGap ?? (sl == null ? "the new trade has no stop" : "equity is unknown")}.`, measured);
    } else if (openRisk + newLossAtStop > cap + 1e-9) {
      set("max_portfolio_exposure", "BLOCK",
        `Open risk ${round(openRisk)} plus this trade ${round(newLossAtStop)} exceeds your portfolio cap of ${round(cap)} (${L.maxPortfolioRiskPercent}% of equity).`,
        measured);
    } else set("max_portfolio_exposure", "PASS", null, measured);
  }

  // ── 4. Leverage (gross notional / equity) ──────────────────────────────
  const unknownNotional = positionMoney.find((m) => m.notional == null);
  const grossOpen = positionMoney.reduce((s, m) => s + (m.notional ?? 0), 0);
  {
    const measured: RiskRuleResult["measured"] = { grossOpen: round(grossOpen), newNotional: newNotional != null ? round(newNotional) : null, equity, maxLeverage: L.maxLeverage };
    if (unknownNotional) set("leverage", "BLOCK", `Cannot size your open ${unknownNotional.p.symbol} position, so leverage cannot be checked.`, measured);
    else if (newNotional == null || equity == null) set("leverage", "BLOCK", `Cannot measure leverage: ${sizingGap ?? "equity is unknown"}.`, measured);
    else {
      const lev = (grossOpen + newNotional) / equity;
      measured["leverage"] = round(lev);
      if (lev > L.maxLeverage + 1e-9) set("leverage", "BLOCK", `This trade takes leverage to ${round(lev, 1)}:1 (limit ${L.maxLeverage}:1).`, measured);
      else set("leverage", "PASS", null, measured);
    }
  }

  // ── 5. Concentration (one symbol) ──────────────────────────────────────
  {
    const same = positionMoney.filter((m) => m.p.symbol === intent.symbol);
    const count = same.length + 1;
    const symNotional = same.reduce((s, m) => s + (m.notional ?? 0), 0) + (newNotional ?? 0);
    const measured: RiskRuleResult["measured"] = { positionsOnSymbol: count, maxPositionsPerSymbol: L.maxPositionsPerSymbol, symbolNotional: round(symNotional), maxSymbolLeverage: L.maxSymbolLeverage };
    if (count > L.maxPositionsPerSymbol) {
      set("concentration", "BLOCK", `${intent.symbol} would have ${count} open positions (limit ${L.maxPositionsPerSymbol} per symbol).`, measured);
    } else if (newNotional == null || equity == null || same.some((m) => m.notional == null)) {
      set("concentration", "BLOCK", `Cannot measure ${intent.symbol} concentration: ${sizingGap ?? "equity is unknown"}.`, measured);
    } else {
      const symLev = symNotional / equity;
      measured["symbolLeverage"] = round(symLev);
      if (symLev > L.maxSymbolLeverage + 1e-9) {
        set("concentration", "BLOCK", `${intent.symbol} exposure would be ${round(symLev, 1)}x equity (limit ${L.maxSymbolLeverage}x for one symbol).`, measured);
      } else set("concentration", "PASS", null, measured);
    }
  }

  // ── 3. Buying power (margin) ───────────────────────────────────────────
  {
    const acct = ctx.account;
    const lev = acct?.leverage != null && acct.leverage > 0 ? Math.min(acct.leverage, 1000) : L.maxLeverage;
    const required = newNotional != null ? newNotional / lev : null;
    const measured = {
      requiredMargin: required != null ? round(required) : null,
      freeMargin: acct?.freeMargin ?? null,
      leverageUsed: lev,
      leverageSource: acct?.leverage != null && acct.leverage > 0 ? "account" : "platform_ceiling",
    };
    if (!acct || acct.freeMargin == null) set("buying_power", "BLOCK", "Free margin is unknown, so buying power cannot be checked.", measured);
    else if (required == null) set("buying_power", "BLOCK", `Cannot compute required margin: ${sizingGap}.`, measured);
    else if (required > acct.freeMargin + 1e-9) {
      set("buying_power", "BLOCK", `This trade needs about ${round(required)} margin but only ${round(acct.freeMargin)} is free.`, measured);
    } else set("buying_power", "PASS", null, measured);
  }

  return finish(results, ctx);
}

// The reason shown to the trader is the root cause: a bad ticket, a dead
// broker or a missing stop explains the downstream "cannot measure" blocks.
const PRIMARY_REASON_ORDER: readonly RiskRuleId[] = [
  "invalid_price_quantity", "broker_unavailable", "stale_market_data", "stop_loss_required",
  "daily_loss_limit", "max_position_size", "duplicate_or_conflicting", "per_trade_loss_limit",
  "max_portfolio_exposure", "leverage", "concentration", "buying_power",
];

function finish(results: Map<RiskRuleId, RiskRuleResult>, ctx: RiskContext): RiskDecision {
  const rules = RISK_RULE_IDS.map((id) => results.get(id) ?? { rule: id, outcome: "NOT_APPLICABLE" as const, reason: null });
  const blocked = rules.filter((r) => r.outcome === "BLOCK");
  const primary = PRIMARY_REASON_ORDER.map((id) => blocked.find((r) => r.rule === id)).find(Boolean);
  return {
    decision: blocked.length ? "BLOCK" : "ALLOW",
    blockedBy: blocked.map((r) => r.rule),
    primaryReason: primary?.reason ?? null,
    rules,
    evaluatedAt: ctx.now.toISOString(),
  };
}
