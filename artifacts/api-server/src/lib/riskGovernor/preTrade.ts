// Pre-trade Risk Governor — the one authority for every pre-trade risk rule:
// the 12 exposure rules plus the trader's own trading discipline (rule 13).
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
  /**
   * Trade-plan facts from a path that collects them (the paper journal, the
   * pre-flight check). Absent = the path has no such concept, and the process
   * gates (playbook, checklist, written reason) do not apply.
   */
  process?: ProcessFacts | null;
  /** Model confidence (0–100) behind an AI-originated order, when the origin reports one. */
  aiConfidence?: number | null;
}

export interface ProcessFacts {
  playbookId?: number | null;
  preTradeCheckDecision?: string | null;
  preTradeCheckPassed?: boolean | null;
  reasonForEntry?: string | null;
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
  "trading_discipline",
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
  /** Peak-to-now equity drawdown cap in percent; null = none configured. */
  maxDrawdownPercent: number | null;
  /** Per-instrument limits by upper-case symbol (trader's symbol_limits). */
  symbolLimits: Record<string, { maxLots: number | null; blocked: boolean }>;
  /** Admin instrument allow-list; null = every instrument. */
  allowedSymbols: string[] | null;
  /** Admin direction restriction; null = both. */
  allowedDirection: "BUY" | "SELL" | null;
  /** False when the admin limited this trader to demo accounts. */
  liveAllowed: boolean;
  /** The trader's own discipline limits (rule 13). */
  discipline: DisciplineLimits;
  /** Which stored value won for each limit, for the audit row. */
  sources: Record<string, string>;
}

/**
 * The trader's trading-discipline settings (user_risk_settings), the rules the
 * old per-user paper engine and the Trade Action guard applied. Count and loss
 * caps block on their own; the softer checks (cooldown, take profit, R:R,
 * overtrading, revenge, process gates) block once two fail together, as they
 * always have.
 */
export interface DisciplineLimits {
  maxOpenTrades: number | null;
  maxTradesPerDay: number | null;
  maxWeeklyLossPercent: number | null;
  maxWeeklyLossAmount: number | null;
  /** null = the trader switched the consecutive-loss block off. */
  maxConsecutiveLosses: number | null;
  cooldownAfterLossMinutes: number | null;
  requireTakeProfit: boolean;
  minRewardRiskRatio: number | null;
  requirePlaybook: boolean;
  requirePreTradeChecklist: boolean;
  requireJournalReason: boolean;
  /** PAPER only: a written trader override may pass a block raised by this rule alone. */
  allowOverrideInPaperMode: boolean;
}

/** Optional discipline columns of user_risk_settings (absent in older fixtures = column default). */
export interface StoredDisciplineSettings {
  maxTradesPerDay?: number | null;
  maxWeeklyLossPercent?: number | null;
  maxWeeklyLossAmount?: number | null;
  maxConsecutiveLosses?: number | null;
  blockAfterConsecutiveLosses?: boolean | null;
  cooldownAfterLossMinutes?: number | null;
  requireTakeProfit?: boolean | null;
  minRewardRiskRatio?: number | null;
  requirePlaybook?: boolean | null;
  requirePreTradeChecklist?: boolean | null;
  requireJournalReason?: boolean | null;
  allowOverrideInPaperMode?: boolean | null;
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
  } & OptionalExposureLimits & StoredDisciplineSettings & { symbolLimits?: unknown } | null;
  /** risk_settings (legacy per-user limits page). */
  legacySettings?: {
    maxDailyLossPct: number;
    maxLotSize: number;
    riskPerTradePct: number;
    maxOpenTrades: number;
    maxTradesPerDay?: number | null;
  } | null;
  /** user_risk_limits (admin-set hard limits). */
  adminLimits?: {
    maxLotSize: number;
    maxDailyLossUsd: number;
    allowedSymbols?: unknown;
    allowedAccountType?: string | null;
    allowedDirection?: string | null;
    /** 0 or null = no admin cap. */
    maxTradesPerDay?: number | null;
  } & OptionalExposureLimits | null;
}

/** Tighten-only exposure columns on user_risk_settings and user_risk_limits (null = not set). */
export interface OptionalExposureLimits {
  maxLeverage?: number | null;
  maxSymbolLeverage?: number | null;
  maxPositionsPerSymbol?: number | null;
  maxPortfolioRiskPercent?: number | null;
  maxDrawdownPercent?: number | null;
}

/** Parse a stored symbol_limits object, ignoring anything malformed. */
export function parseSymbolLimits(raw: unknown): Record<string, { maxLots: number | null; blocked: boolean }> {
  const out: Record<string, { maxLots: number | null; blocked: boolean }> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [sym, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const maxLots = typeof o["maxLots"] === "number" && Number.isFinite(o["maxLots"]) && o["maxLots"] >= 0 ? o["maxLots"] : null;
    const blocked = o["blocked"] === true || maxLots === 0;
    out[sym.trim().toUpperCase()] = { maxLots: maxLots === 0 ? null : maxLots, blocked };
  }
  return out;
}

// Defaults when the trader never saved a settings row — the same column
// defaults user_risk_settings ships with.
const USER_DEFAULTS = {
  maxRiskPerTradePercent: 1,
  maxDailyLossPercent: 3,
  maxOpenTrades: 3,
  requireStopLoss: true,
  blockAfterDailyLossHit: true,
  maxTradesPerDay: 5,
  maxConsecutiveLosses: 3,
  blockAfterConsecutiveLosses: true,
  cooldownAfterLossMinutes: 30,
  requireTakeProfit: false,
  minRewardRiskRatio: 1.5,
  requirePlaybook: true,
  requirePreTradeChecklist: true,
  requireJournalReason: true,
  allowOverrideInPaperMode: true,
} as const;

function resolveDiscipline(
  u: StoredLimitRows["userSettings"],
  legacyMaxOpen: number | null | undefined,
  legacyMaxTradesPerDay: number | null | undefined,
  adminMaxTradesPerDay: number | null | undefined,
  sources: Record<string, string>,
): DisciplineLimits {
  const pick = <K extends keyof typeof USER_DEFAULTS>(k: K, v: unknown): (typeof USER_DEFAULTS)[K] =>
    (v === undefined || v === null ? USER_DEFAULTS[k] : v) as (typeof USER_DEFAULTS)[K];
  const positive = (v: number | null | undefined) => (v != null && Number.isFinite(v) && v > 0 ? v : null);
  const open = strictest([
    [u ? "user_risk_settings.max_open_trades" : "default:user_risk_settings.max_open_trades", u ? u.maxOpenTrades : USER_DEFAULTS.maxOpenTrades],
    ["risk_settings.max_open_trades", legacyMaxOpen],
  ]);
  sources["maxOpenTrades"] = open.source;
  const perDay = strictest([
    [u ? "user_risk_settings.max_trades_per_day" : "default:user_risk_settings.max_trades_per_day", pick("maxTradesPerDay", u?.maxTradesPerDay)],
    ["risk_settings.max_trades_per_day", legacyMaxTradesPerDay],
    ["user_risk_limits.max_trades_per_day", adminMaxTradesPerDay],
  ]);
  sources["maxTradesPerDay"] = perDay.source;
  const blockStreak = pick("blockAfterConsecutiveLosses", u?.blockAfterConsecutiveLosses);
  sources["discipline"] = u ? "user_risk_settings" : "default:user_risk_settings";
  return {
    maxOpenTrades: open.value,
    maxTradesPerDay: perDay.value,
    maxWeeklyLossPercent: positive(u?.maxWeeklyLossPercent),
    maxWeeklyLossAmount: positive(u?.maxWeeklyLossAmount),
    maxConsecutiveLosses: blockStreak ? positive(pick("maxConsecutiveLosses", u?.maxConsecutiveLosses)) : null,
    cooldownAfterLossMinutes: positive(pick("cooldownAfterLossMinutes", u?.cooldownAfterLossMinutes)),
    requireTakeProfit: pick("requireTakeProfit", u?.requireTakeProfit),
    minRewardRiskRatio: positive(pick("minRewardRiskRatio", u?.minRewardRiskRatio)),
    requirePlaybook: pick("requirePlaybook", u?.requirePlaybook),
    requirePreTradeChecklist: pick("requirePreTradeChecklist", u?.requirePreTradeChecklist),
    requireJournalReason: pick("requireJournalReason", u?.requireJournalReason),
    allowOverrideInPaperMode: pick("allowOverrideInPaperMode", u?.allowOverrideInPaperMode),
  };
}

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
  const portfolio = strictest([
    ["platform", PLATFORM_RISK_CEILINGS.maxPortfolioRiskPercent],
    ["per_trade_percent x max_open_trades", perTrade * Math.max(1, maxOpen)],
    ["user_risk_settings.max_portfolio_risk_percent", u?.maxPortfolioRiskPercent],
    ["user_risk_limits.max_portfolio_risk_percent", a?.maxPortfolioRiskPercent],
  ]);
  sources["maxPortfolioRiskPercent"] = portfolio.source;

  const exposure = (key: keyof OptionalExposureLimits, column: string, ceiling: number | null) => {
    const r = strictest([
      ["platform", ceiling],
      [`user_risk_settings.${column}`, u?.[key]],
      [`user_risk_limits.${column}`, a?.[key]],
    ]);
    sources[key] = r.source;
    return r.value;
  };
  const maxLeverage = exposure("maxLeverage", "max_leverage", PLATFORM_RISK_CEILINGS.maxLeverage)!;
  const maxSymbolLeverage = exposure("maxSymbolLeverage", "max_symbol_leverage", PLATFORM_RISK_CEILINGS.maxSymbolLeverage)!;
  const maxPositionsPerSymbol = exposure("maxPositionsPerSymbol", "max_positions_per_symbol", PLATFORM_RISK_CEILINGS.maxPositionsPerSymbol)!;
  const maxDrawdownPercent = exposure("maxDrawdownPercent", "max_drawdown_percent", null);

  const allowed = Array.isArray(a?.allowedSymbols)
    ? (a!.allowedSymbols as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().toUpperCase())
    : [];
  const dir = String(a?.allowedDirection ?? "both").toLowerCase();

  return {
    maxLotSize: lot.value ?? PLATFORM_RISK_CEILINGS.maxLotSize,
    maxRiskPerTradePercent: perTrade,
    maxRiskPerTradeAmount: perTradeAmt.value,
    maxDailyLossPercent: dailyPct.value,
    maxDailyLossAmount: dailyAmt.value,
    requireStopLoss: u ? u.requireStopLoss : USER_DEFAULTS.requireStopLoss,
    maxPortfolioRiskPercent: portfolio.value ?? PLATFORM_RISK_CEILINGS.maxPortfolioRiskPercent,
    maxLeverage,
    maxSymbolLeverage,
    maxPositionsPerSymbol,
    maxQuoteAgeMs: PLATFORM_RISK_CEILINGS.maxQuoteAgeMs,
    duplicateWindowMs: PLATFORM_RISK_CEILINGS.duplicateWindowMs,
    maxDrawdownPercent,
    symbolLimits: parseSymbolLimits(u?.symbolLimits),
    allowedSymbols: allowed.length ? allowed : null,
    allowedDirection: dir === "buy" ? "BUY" : dir === "sell" ? "SELL" : null,
    // Same reading as the Trade Action guard: an admin row set to "demo" keeps
    // the trader off live accounts. No admin row = no restriction here.
    liveAllowed: a ? String(a.allowedAccountType ?? "demo").toLowerCase() !== "demo" : true,
    discipline: resolveDiscipline(u, l?.maxOpenTrades, l?.maxTradesPerDay, a?.maxTradesPerDay, sources),
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

export interface AccountSnapshotFacts {
  status: "FRESH" | "STALE" | "MISSING";
  observedAt: Date | null;
  source: string;
}

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
  /**
   * Freshness of the broker account snapshot (Broker Hub) behind `account`.
   * Set when the order books against a broker account the trader owns; absent
   * for paper and shared-master virtual ledgers, which ARX keeps itself.
   */
  accountSnapshot?: AccountSnapshotFacts | null;
  daily: { realizedPnl: number | null; floatingPnl: number | null };
  /**
   * Highest equity the governor has recorded for this account (user_equity_peaks).
   * Needed only when a drawdown limit is set; null = none recorded yet.
   */
  equityPeak?: { peakEquity: number; since: Date | null; source: string } | null;
  /** Stop switches (lib/safety/tradingHalt). Engaged halts new risk; closes stay open. */
  halt?: RiskHalt | null;
  /**
   * The trader's recent activity on this venue, for rule 13. The context
   * loader always sets it (null = it could not be read, which blocks new risk
   * when a discipline cap is set); absent only in pure fixtures that do not
   * exercise rule 13.
   */
  activity?: TradingActivity | null;
  /**
   * Market conditions the venue reports beyond the quote (spread, news
   * window). Checked by rule 10 on entries; absent = the venue has none.
   */
  market?: { spreadTooWide: boolean; newsBlock: string | null; source: string } | null;
  /** Hard rules a venue adds for every order it books (the simulator OMS). Checked by rule 13. */
  venueRules?: VenueRules | null;
  /**
   * Shared-master routing only: the trader's virtual allocation. New risk is
   * refused while it is not active, is exhausted, or has closed trades whose
   * P/L could not be sized yet. Checked by rule 3 (buying power).
   */
  allocation?: { status: string; blown: boolean; pendingSizing: boolean; source: string } | null;
}

export interface VenueRules {
  source: string;
  requireTakeProfit?: boolean;
  minRewardRiskRatio?: number | null;
  /** Minimum model confidence for orders from ruby / automation / strategy origins. */
  minAiConfidence?: number | null;
}

export interface TradingActivity {
  /** Trades opened today (UTC) that are still open, plus trades closed today. */
  tradesToday: number;
  weekRealizedPnl: number;
  consecutiveLosses: number;
  lastClosedAt: Date | null;
  lastClosedWasLoss: boolean;
  closesInLastHour: number;
  reentriesAfterLossInLastHour: number;
  source: string;
}

/** Summarise a venue's closed trades (any order) and today's still-open entries. */
export function summarizeActivity(
  closes: ReadonlyArray<{ closedAt: Date; pnl: number }>,
  openedTodayStillOpen: number,
  now: Date,
  source: string,
): TradingActivity {
  const day = new Date(now); day.setUTCHours(0, 0, 0, 0);
  const week = now.getTime() - 7 * 86_400_000;
  const hour = now.getTime() - 60 * 60_000;
  const sorted = [...closes].sort((a, b) => b.closedAt.getTime() - a.closedAt.getTime());
  let consecutiveLosses = 0;
  for (const c of sorted) { if (c.pnl < 0) consecutiveLosses++; else break; }
  const last = sorted[0] ?? null;
  return {
    tradesToday: openedTodayStillOpen + sorted.filter((c) => c.closedAt >= day).length,
    weekRealizedPnl: round(sorted.filter((c) => c.closedAt.getTime() >= week).reduce((s, c) => s + c.pnl, 0)),
    consecutiveLosses,
    lastClosedAt: last?.closedAt ?? null,
    lastClosedWasLoss: !!last && last.pnl < 0,
    closesInLastHour: sorted.filter((c) => c.closedAt.getTime() >= hour).length,
    reentriesAfterLossInLastHour: sorted.filter((c, i) => c.closedAt.getTime() >= hour && (sorted[i + 1]?.pnl ?? 0) < 0).length,
    source,
  };
}

export interface RiskHalt {
  engaged: boolean;
  sources: string[];
  reason: string | null;
}

/** Not one of the 13 rules: an engaged stop switch, reported ahead of them. */
export const TRADING_HALT = "trading_halt" as const;

export type RuleOutcome = "PASS" | "BLOCK" | "NOT_APPLICABLE";

export interface RiskRuleResult {
  rule: RiskRuleId;
  outcome: RuleOutcome;
  reason: string | null;
  measured?: Record<string, number | string | boolean | null>;
}

export interface RiskDecision {
  decision: "ALLOW" | "BLOCK";
  blockedBy: Array<RiskRuleId | typeof TRADING_HALT>;
  primaryReason: string | null;
  rules: RiskRuleResult[];
  evaluatedAt: string;
  /** The stop-switch state the decision saw. */
  halt?: RiskHalt | null;
}

const round = (n: number, dp = 2) => Number(n.toFixed(dp));

function moneyPerPriceUnit(lots: number, inst: InstrumentModel | undefined): number | null {
  if (!inst || inst.contractSize == null || inst.quoteToAccountFx == null) return null;
  return lots * inst.contractSize * inst.quoteToAccountFx;
}

export function evaluatePreTradeRisk(intent: TradeIntent, ctx: RiskContext): RiskDecision {
  const d = evaluateRules(intent, ctx);
  const halt = ctx.halt ?? null;
  // A kill switch halts new risk and any stop that moves away; closing and
  // tightening a known stop stay possible so a trader can always cut risk.
  // Paths with stricter close rules keep them.
  const reduces = intent.action === "CLOSE" || intent.action === "PARTIAL_CLOSE" || tightensKnownStop(intent);
  if (!halt?.engaged || reduces) return { ...d, halt };
  return {
    ...d,
    decision: "BLOCK",
    blockedBy: [TRADING_HALT, ...d.blockedBy],
    primaryReason: `Trading is halted: ${halt.reason ?? halt.sources.join(", ")}`,
    halt,
  };
}

/** True when moving a stop from `current` to `next` adds risk (further from price, or removed). */
export function isStopWidened(side: "BUY" | "SELL", current: number, next: number | null): boolean {
  if (next == null) return true;
  return side === "BUY" ? next < current - 1e-12 : next > current + 1e-12;
}

function tightensKnownStop(intent: TradeIntent): boolean {
  const pos = intent.position;
  const sl = intent.stopLoss;
  if (intent.action !== "MODIFY" || !pos || pos.stopLoss == null || sl == null || !intent.side) return false;
  return intent.side === "BUY" ? sl >= pos.stopLoss : sl <= pos.stopLoss;
}

function evaluateRules(intent: TradeIntent, ctx: RiskContext): RiskDecision {
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
    const snap = ctx.accountSnapshot ?? null;
    const measured = { status: b.status, lastSeenAt: b.lastSeenAt?.toISOString() ?? null, detail: b.detail };
    if (b.status === "DISCONNECTED") {
      set("broker_unavailable", "BLOCK", `Broker is disconnected (${b.detail}). No order can be sent.`, measured);
    } else if (b.status === "DEGRADED" && !reduces) {
      set("broker_unavailable", "BLOCK", `Broker connection is degraded (${b.detail}). New risk is paused; closing is still allowed.`, measured);
    } else if (snap && snap.status !== "FRESH" && !reduces && !tightensKnownStop(intent)) {
      // Equity, margin and leverage size this order. Stale or missing account
      // facts refuse risk on this account only; closing stays allowed.
      const why = snap.status === "MISSING"
        ? "the broker has not reported this account's balance yet"
        : `the broker last reported this account at ${snap.observedAt?.toISOString() ?? "an unknown time"}`;
      set("broker_unavailable", "BLOCK",
        `Account data is ${snap.status.toLowerCase()}: ${why}. New risk on this account is refused until it refreshes; closing is still allowed.`,
        { ...measured, accountSnapshot: snap.status, accountObservedAt: snap.observedAt?.toISOString() ?? null, accountSource: snap.source });
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
      const m = ctx.market ?? null;
      if (ageMs > L.maxQuoteAgeMs) {
        set("stale_market_data", "BLOCK", `Quote for ${intent.symbol} is ${Math.round(ageMs / 1000)}s old (limit ${L.maxQuoteAgeMs / 1000}s).`, measured);
      } else if (m?.newsBlock) {
        set("stale_market_data", "BLOCK", `${intent.symbol} is inside a high-impact news window: ${m.newsBlock}.`, { ...measured, marketSource: m.source });
      } else if (m?.spreadTooWide) {
        set("stale_market_data", "BLOCK", `The ${intent.symbol} spread is too wide to enter.`, { ...measured, marketSource: m.source });
      } else set("stale_market_data", "PASS", null, measured);
    }
  }

  // ── 1. Maximum position size, with instrument and account limits ───────
  {
    const inst = ctx.instruments[intent.symbol];
    const sym = intent.symbol.trim().toUpperCase();
    const symLimit = L.symbolLimits[sym] ?? null;
    const brokerMax = inst?.maxVolume != null && inst.maxVolume > 0 ? inst.maxVolume : null;
    const caps: Array<[string, number]> = [[L.sources["maxLotSize"] ?? "platform", L.maxLotSize]];
    if (brokerMax != null) caps.push(["broker_max_volume", brokerMax]);
    if (symLimit?.maxLots != null) caps.push([`user_risk_settings.symbol_limits.${sym}`, symLimit.maxLots]);
    const [source, cap] = caps.reduce((a, b) => (b[1] < a[1] ? b : a));
    const measured = { lots, maxLotSize: cap, source };
    if (intent.venue === "LIVE" && !L.liveAllowed) {
      set("max_position_size", "BLOCK", "Your account is limited to demo trading by an administrator.", { ...measured, limit: "user_risk_limits.allowed_account_type" });
    } else if (L.allowedSymbols && !L.allowedSymbols.includes(sym)) {
      set("max_position_size", "BLOCK", `${intent.symbol} is not on the instruments an administrator allowed for your account.`, { ...measured, limit: "user_risk_limits.allowed_symbols" });
    } else if (L.allowedDirection && intent.side && intent.side !== L.allowedDirection) {
      set("max_position_size", "BLOCK", `Your account is restricted to ${L.allowedDirection} trades only.`, { ...measured, limit: "user_risk_limits.allowed_direction" });
    } else if (symLimit?.blocked) {
      set("max_position_size", "BLOCK", `Trading ${intent.symbol} is switched off in your risk limits.`, { ...measured, limit: `user_risk_settings.symbol_limits.${sym}` });
    } else if (lots != null && lots > cap) set("max_position_size", "BLOCK", `Lot size ${lots} exceeds your maximum of ${cap}${source.includes("symbol_limits") ? ` for ${intent.symbol}` : ""}.`, measured);
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
    // Drawdown from the account's recorded equity peak (when a cap is set).
    if (L.maxDrawdownPercent != null && results.get("daily_loss_limit")?.outcome !== "BLOCK") {
      const prior = results.get("daily_loss_limit")!;
      const peakFact = ctx.equityPeak ?? null;
      const m: RiskRuleResult["measured"] = { ...(prior.measured ?? {}), maxDrawdownPercent: L.maxDrawdownPercent,
        peakEquity: peakFact?.peakEquity ?? null, peakSince: peakFact?.since?.toISOString() ?? null };
      if (equity == null) {
        set("daily_loss_limit", "BLOCK", "Account equity is unknown, so your drawdown limit cannot be checked.", m);
      } else {
        const peak = Math.max(equity, peakFact?.peakEquity ?? equity);
        const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
        m["peakEquity"] = round(peak);
        m["drawdownPercent"] = round(dd);
        if (dd >= L.maxDrawdownPercent) {
          set("daily_loss_limit", "BLOCK",
            `Account is ${round(dd)}% below its peak equity of ${round(peak)} (drawdown limit ${L.maxDrawdownPercent}%). New trades are blocked; closing is allowed.`, m);
        } else set("daily_loss_limit", "PASS", null, m);
      }
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

  // ── 13. Trading discipline (the trader's own settings) ─────────────────
  evaluateDiscipline(intent, ctx, ref, sl, tp, set);

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
    const alloc = ctx.allocation ?? null;
    if (alloc && alloc.status !== "active") {
      set("buying_power", "BLOCK", `Your shared-account allocation is ${alloc.status}. New trades are blocked; closing is allowed.`, { ...measured, allocation: alloc.source });
    } else if (alloc?.blown) {
      set("buying_power", "BLOCK", "Your shared-account allocation is exhausted. New trades are blocked until it is reset; closing is allowed.", { ...measured, allocation: alloc.source });
    } else if (alloc?.pendingSizing) {
      set("buying_power", "BLOCK", "Some closed trades are still awaiting correct P/L sizing, so your remaining allocation cannot be verified. New trades are paused; closing is allowed.", { ...measured, allocation: alloc.source });
    } else if (!acct || acct.freeMargin == null) set("buying_power", "BLOCK", "Free margin is unknown, so buying power cannot be checked.", measured);
    else if (required == null) set("buying_power", "BLOCK", `Cannot compute required margin: ${sizingGap}.`, measured);
    else if (required > acct.freeMargin + 1e-9) {
      set("buying_power", "BLOCK", `This trade needs about ${round(required)} margin but only ${round(acct.freeMargin)} is free.`, measured);
    } else set("buying_power", "PASS", null, measured);
  }

  return finish(results, ctx);
}

/** Share of the daily loss cap after which automated origins stop opening. */
export const AUTOMATION_DAILY_BUDGET_SHARE = 0.7;

function evaluateDiscipline(
  intent: TradeIntent,
  ctx: RiskContext,
  ref: number | null,
  sl: number | null,
  tp: number | null,
  set: (rule: RiskRuleId, outcome: RuleOutcome, reason: string | null, measured?: RiskRuleResult["measured"]) => void,
): void {
  const D = ctx.limits.discipline;
  const act = ctx.activity;
  const hard: string[] = [];
  const soft: string[] = [];
  const measured: Record<string, number | string | boolean | null> = {};

  // Count and loss caps need the activity facts; unreadable facts refuse new
  // risk only when a cap is actually set.
  const needsActivity = D.maxTradesPerDay != null || D.maxWeeklyLossAmount != null || D.maxWeeklyLossPercent != null
    || D.maxConsecutiveLosses != null || D.cooldownAfterLossMinutes != null;
  if (act === undefined) {
    measured["activity"] = "not supplied";
  } else if (act === null) {
    if (needsActivity) hard.push("your recent trading activity could not be read, so your trade-count and loss-streak limits cannot be checked");
  } else {
    Object.assign(measured, {
      tradesToday: act.tradesToday, weekRealizedPnl: act.weekRealizedPnl, consecutiveLosses: act.consecutiveLosses,
      activitySource: act.source,
    });
    if (D.maxTradesPerDay != null && act.tradesToday >= D.maxTradesPerDay) {
      hard.push(`you have reached your ${D.maxTradesPerDay} trades for today`);
    }
    if (D.maxWeeklyLossAmount != null && act.weekRealizedPnl <= -D.maxWeeklyLossAmount) {
      hard.push(`this week's loss ${round(-act.weekRealizedPnl)} reached your weekly cap of ${D.maxWeeklyLossAmount}`);
    }
    if (D.maxWeeklyLossPercent != null && act.weekRealizedPnl < 0) {
      const equity = ctx.account?.equity != null && ctx.account.equity > 0 ? ctx.account.equity : null;
      if (equity == null) hard.push("account equity is unknown, so your weekly loss percentage cannot be checked");
      else {
        const pct = (-act.weekRealizedPnl / equity) * 100;
        measured["weekLossPercent"] = round(pct);
        if (pct >= D.maxWeeklyLossPercent) hard.push(`this week's loss ${round(pct)}% reached your weekly cap of ${D.maxWeeklyLossPercent}%`);
      }
    }
    if (D.maxConsecutiveLosses != null && act.consecutiveLosses >= D.maxConsecutiveLosses) {
      hard.push(`${act.consecutiveLosses} losses in a row reached your limit of ${D.maxConsecutiveLosses}`);
    }
    if (D.cooldownAfterLossMinutes != null && act.lastClosedWasLoss && act.lastClosedAt) {
      const elapsed = (ctx.now.getTime() - act.lastClosedAt.getTime()) / 60_000;
      if (elapsed < D.cooldownAfterLossMinutes) {
        soft.push(`you are in a ${D.cooldownAfterLossMinutes}-minute cooldown after a loss (${Math.ceil(D.cooldownAfterLossMinutes - elapsed)} min left)`);
      }
    }
    if (act.closesInLastHour >= 5) soft.push(`${act.closesInLastHour} trades closed in the last hour (overtrading)`);
    if (act.reentriesAfterLossInLastHour >= 2) soft.push("repeated re-entries right after losses (revenge pattern)");
  }

  // Automation stops opening once 70% of the daily loss cap is used, leaving
  // the rest of the budget to the trader (the old readiness pause, per user).
  if ((intent.origin === "automation" || intent.origin === "strategy") && ctx.daily.realizedPnl != null) {
    const L = ctx.limits;
    const combined = ctx.daily.realizedPnl + (ctx.daily.floatingPnl != null && ctx.daily.floatingPnl < 0 ? ctx.daily.floatingPnl : 0);
    const equity = ctx.account?.equity != null && ctx.account.equity > 0 ? ctx.account.equity : null;
    const used = [
      L.maxDailyLossAmount != null ? -combined / L.maxDailyLossAmount : null,
      L.maxDailyLossPercent != null && equity != null ? ((-combined / equity) * 100) / L.maxDailyLossPercent : null,
    ].filter((v): v is number => v != null);
    const share = used.length ? Math.max(...used) : 0;
    measured["dailyBudgetUsed"] = round(share, 3);
    if (share >= AUTOMATION_DAILY_BUDGET_SHARE) {
      hard.push(`${Math.round(share * 100)}% of today's loss budget is used; automation pauses at ${AUTOMATION_DAILY_BUDGET_SHARE * 100}%`);
    }
  }

  const V = ctx.venueRules ?? null;
  if (V) {
    measured["venueRules"] = V.source;
    if (V.requireTakeProfit && tp == null) hard.push(`${V.source} requires a take profit`);
    if (V.minRewardRiskRatio != null && ref != null && sl != null && tp != null && intent.side) {
      const risk = intent.side === "BUY" ? ref - sl : sl - ref;
      const reward = intent.side === "BUY" ? tp - ref : ref - tp;
      const rr = risk > 0 ? reward / risk : 0;
      if (rr < V.minRewardRiskRatio) hard.push(`reward:risk ${round(rr, 2)} is below the ${V.source} floor of ${V.minRewardRiskRatio}`);
    }
    if (V.minAiConfidence != null && (intent.origin === "ruby" || intent.origin === "automation" || intent.origin === "strategy")) {
      const c = intent.aiConfidence ?? 0;
      measured["aiConfidence"] = c;
      if (c < V.minAiConfidence) hard.push(`model confidence ${c} is below the ${V.source} minimum of ${V.minAiConfidence}`);
    }
  }

  if (D.maxOpenTrades != null) {
    const open = ctx.positions.length + ctx.inFlight.filter((f) => f.kind === "pending" && f.ref !== intent.intentRef).length;
    measured["openTrades"] = open;
    measured["maxOpenTrades"] = D.maxOpenTrades;
    if (open >= D.maxOpenTrades) hard.push(`${open} trades are already open (your limit is ${D.maxOpenTrades})`);
  }
  if (D.requireTakeProfit && tp == null) soft.push("a take profit is required by your settings");
  if (D.minRewardRiskRatio != null && ref != null && sl != null && tp != null && intent.side) {
    const risk = intent.side === "BUY" ? ref - sl : sl - ref;
    const reward = intent.side === "BUY" ? tp - ref : ref - tp;
    if (risk > 0 && reward > 0) {
      const rr = reward / risk;
      measured["rewardRisk"] = round(rr, 3);
      if (rr < D.minRewardRiskRatio) soft.push(`reward:risk ${round(rr, 2)} is below your minimum of ${D.minRewardRiskRatio}`);
    }
  }
  const p = intent.process;
  if (p) {
    if (D.requirePlaybook && (p.playbookId == null || !Number.isFinite(p.playbookId))) soft.push("a playbook is required for this setup");
    if (D.requirePreTradeChecklist) {
      if (p.preTradeCheckDecision === "block") soft.push("the pre-trade checklist returned BLOCK");
      else if (p.preTradeCheckDecision == null && p.preTradeCheckPassed !== true) soft.push("the pre-trade checklist has not been run");
    }
    if (D.requireJournalReason && (!p.reasonForEntry || p.reasonForEntry.trim().length < 5)) soft.push("a written reason for entry is required");
  }

  measured["hard"] = hard.length;
  measured["soft"] = soft.length;
  if (soft.length) measured["warnings"] = soft.join("; ");
  const fails = [...hard, ...soft];
  if (hard.length || soft.length >= 2) {
    const head = fails[0]!;
    set("trading_discipline", "BLOCK",
      `Blocked by your trading rules: ${head}${fails.length > 1 ? ` (+${fails.length - 1} more)` : ""}.`, measured);
  } else {
    set("trading_discipline", "PASS", null, measured);
  }
}

// The reason shown to the trader is the root cause: a bad ticket, a dead
// broker or a missing stop explains the downstream "cannot measure" blocks.
const PRIMARY_REASON_ORDER: readonly RiskRuleId[] = [
  "invalid_price_quantity", "broker_unavailable", "stale_market_data", "stop_loss_required",
  "daily_loss_limit", "trading_discipline", "max_position_size", "duplicate_or_conflicting", "per_trade_loss_limit",
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
