// T023 — Ruby context builder.
//
// Produces a compact, plain-English "current briefing" for the AI assistant
// panel from REAL app state only. This replaces the static repeated greeting.
//
// Honesty / safety rules (hard constraints):
//   - Never fabricates market data, news, weather, or location. A data source
//     that is not connected is simply omitted (honest absence), never faked.
//   - No internal details leak to normal users: no env names, gate IDs, route
//     names, raw account numbers, tokens, or stack traces. Real MT5 master
//     balances are exposed to OWNER/ADMIN only; normal users see their own ARX
//     allocation and a clean readiness state.
//   - Ruby never becomes an execution gate here. This is informational only.
//   - Weather + user location have no provider in this codebase, so they are
//     always reported as unavailable (never guessed).
//   - Setup guidance is state-gated: it only appears when the live state truly
//     requires it, so solved setup steps are not repeated.
import { getUserAllocationView } from "../live/masterBridgePool.js";
import { analyzeSession } from "../../brain/sessions/sessionEngine.js";
import { getSymbolTradability } from "../data/symbolTradability.js";
import { classifySymbol } from "../data/marketDataRouter.js";
import { isApprovedArxMarket } from "@workspace/domain/market";
import {
  deriveNewsRiskScore,
  newsRiskLevelOf,
  type MarketHeatNewsRiskLevel,
} from "@workspace/domain/market-heat";
import { getTradeHistorySummary } from "../tradeHistory/service.js";
import { getMarketProvider } from "./marketProvider.js";
import { sanitizeExternalText } from "../security/promptInjectionGuard.js";
import { buildLiveAccountSnapshot } from "../live/liveAccountSnapshot.js";
import { db, arxLivePositionsTable, mt5ConnectionTable } from "@workspace/db";
import { eq, isNull, and } from "drizzle-orm";
import { getUserModeScope } from "../modeScope/getUserModeScope.js";
import { getEconomicCalendar } from "../news/economicCalendarProvider.js";

export type RubyRole = "USER" | "ADMIN" | "OWNER";
export type TimeOfDay = "morning" | "afternoon" | "evening";

export interface RubyContext {
  generatedAt: string;
  page: { key: string; label: string };
  role: RubyRole;
  isPrivileged: boolean;
  timeOfDay: TimeOfDay;
  serverUtcHour: number;
  session: {
    name: string;
    liquidity: string;
    score: number;
    forexOpen: boolean;
  } | null;
  symbol: {
    symbol: string;
    tradable: "yes" | "no" | "unknown";
    badge: string;
    assetClass: string;
    /**
     * Shared chart-truth feed status for the selected symbol (the SAME resolver
     * the chart uses), so the briefing reports identical source/quality/freshness
     * to the chart. null when no symbol is selected or the resolver errored.
     */
    marketFeed: {
      source: string | null;
      quality: string;
      freshness: string;
      aiUsable: boolean;
      isLive: boolean;
      lastPrice: number | null;
    } | null;
  } | null;
  bridge: {
    availability: "HEALTHY" | "RECONCILING" | "UNAVAILABLE";
    connected: boolean;
    message: string;
  };
  account: {
    // OWNER/ADMIN only — real MT5 master snapshot. null for normal users.
    mt5: {
      balance: number;
      equity: number;
      openPnl: number;
      currency: string | null;
      snapshotStatus: string;
    } | null;
    // Every user's own ARX allocation slice.
    allocation: { allocated: number; available: number; reserved: number } | null;
    /** Count of the user's open positions. null = the lookup failed — honestly
     *  unknown, NEVER a confident zero (the account may hold live positions). */
    openPositions: number | null;
    /** Open floating P/L from the shared buildLiveAccountSnapshot adapter. null = not available. */
    openPL: number | null;
    /** Freshness of the open P/L figure — same bands as the frontend badge. */
    snapshotFreshness: string | null;
    /** Task #430 — canonical mark-to-market balance (single source of truth,
     *  same numbers as the user's own Dashboard). floatingPnL null = unavailable. */
    live: {
      source: "live_shared" | "demo" | "paper" | "unknown";
      allocatedBalance: number;
      realizedPnL: number;
      floatingPnL: number | null;
      liveEquity: number;
      marginUsed: number;
      freeMargin: number;
      availableBalance: number;
      openTradeCount: number;
      freshness: { status: "fresh" | "stale" | "unavailable"; lastUpdatedAt: string | null; ageMs: number | null };
    } | null;
  };
  performance: {
    hasTrades: boolean;
    count?: number;
    closedCount?: number;
    winRate?: number;
    netPnl?: number;
  };
  news: {
    connected: boolean;
    items: Array<{ headline: string; source: string }>;
    /** Real severity + recency derived risk level; `unavailable` when not connected. */
    riskLevel: MarketHeatNewsRiskLevel;
  };
  calendar: {
    connected: boolean;
    next: { title: string; region: string; importance: string; whenIso: string } | null;
  };
  weather: { available: false };
  location: { available: false };
  warnings: string[];
}

export interface RubyBriefing {
  headline: string;
  lines: string[];
  setupGuidance: string | null;
  suggestions: Array<{ label: string; prompt: string }>;
  updatedAt: string;
  mode: string;
}

// ── Lightweight 60s cache for the network-bound news/calendar lookups so
//    repeated panel opens don't hammer providers or block the briefing. ──────
const EXT_TTL_MS = 60_000;
type NewsCacheVal = {
  connected: boolean;
  items: Array<{ headline: string; source: string }>;
  riskLevel: MarketHeatNewsRiskLevel;
};
type CalCacheVal = RubyContext["calendar"];
const newsCache = new Map<string, { at: number; val: NewsCacheVal }>();
let calCache: { at: number; val: CalCacheVal } | null = null;

function timeOfDayFromHour(hour: number): TimeOfDay {
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

function pageLabel(key: string): string {
  const k = key.toLowerCase();
  if (k.includes("scanner")) return "Scanner";
  if (k.includes("cockpit") || k === "/" || k.includes("dashboard")) return "Cockpit";
  if (k.includes("trade") || k.includes("position")) return "Trades";
  if (k.includes("performance") || k.includes("analytics")) return "Performance";
  if (k.includes("mt5") || k.includes("setup")) return "MT5 Setup";
  return "ARX";
}

/**
 * Pure mapping from a market-news provider result to Ruby's news-risk cache
 * value. Extracted so the honesty-critical branch is unit-testable without a
 * provider or DB (see `__qa__/rubyNewsRiskHonesty.test.ts`).
 *
 * Honesty contract:
 *   - A *connected* provider always yields `connected: true` and a REAL,
 *     severity+recency-derived `riskLevel`. A connected feed with zero
 *     headlines is a genuinely quiet feed: `deriveNewsRiskScore([]) === 0` ⇒
 *     `riskLevel: "low"` — NOT `"unavailable"`.
 *   - Only a *disconnected* provider reads `"unavailable"` (and a thrown
 *     provider error is treated as disconnected by the caller).
 */
export function deriveNewsCacheVal(
  res: {
    connected: boolean;
    items: Array<{ headline: string; source: string; summary?: string | null; publishedAt?: string | null }>;
  },
  nowMs: number,
): NewsCacheVal {
  if (!res.connected) {
    return { connected: false, items: [], riskLevel: "unavailable" };
  }
  // Real severity + recency derived risk over ALL fetched items (display is
  // still trimmed to the latest 2).
  const { riskScore } = deriveNewsRiskScore(
    res.items.map((i) => ({
      headline: i.headline,
      summary: i.summary ?? null,
      publishedAt: i.publishedAt ?? null,
    })),
    nowMs,
  );
  return {
    connected: true,
    items: res.items.slice(0, 2).map((i) => ({
      headline: sanitizeExternalText(i.headline, { source: "market_news", field: "headline" }),
      source: sanitizeExternalText(i.source, { source: "market_news", field: "source" }),
    })),
    riskLevel: newsRiskLevelOf(riskScore),
  };
}

async function fetchNews(symbol: string | null): Promise<NewsCacheVal> {
  const key = (symbol ?? "forex").toUpperCase();
  const hit = newsCache.get(key);
  if (hit && Date.now() - hit.at < EXT_TTL_MS) return hit.val;
  let val: NewsCacheVal = { connected: false, items: [], riskLevel: "unavailable" };
  try {
    const provider = getMarketProvider();
    const res = await provider.getMarketNews(symbol ?? "forex markets", 8);
    val = deriveNewsCacheVal(res, Date.now());
  } catch {
    val = { connected: false, items: [], riskLevel: "unavailable" };
  }
  newsCache.set(key, { at: Date.now(), val });
  return val;
}

async function fetchCalendar(): Promise<CalCacheVal> {
  if (calCache && Date.now() - calCache.at < EXT_TTL_MS) return calCache.val;
  let val: CalCacheVal = { connected: false, next: null };
  try {
    // Use the unified TE seam (economicCalendarProvider) so all calendar surfaces
    // share ONE provider path. The market-provider chain has no TE wiring and
    // returns connected:false for every calendar call regardless of key config.
    const res = await getEconomicCalendar(""); // empty = all symbols (briefing-level)
    if (res.connected && res.events.length > 0) {
      const now = Date.now();
      // RawCalendarEvent uses `impact` and `eventTimeIso` (not `importance`/`whenIso`).
      const upcoming = res.events
        .filter((e) => e.impact === "high" && new Date(e.eventTimeIso).getTime() >= now)
        .sort((a, b) => new Date(a.eventTimeIso).getTime() - new Date(b.eventTimeIso).getTime())[0];
      if (upcoming) {
        val = {
          connected: true,
          next: {
            title: sanitizeExternalText(upcoming.title, { source: "economic_calendar", field: "title" }),
            // `currency` is the affected currency code (e.g. "USD", "EUR") — closest
            // available approximation to a "region" label in the briefing.
            region: sanitizeExternalText(upcoming.currency, { source: "economic_calendar", field: "region" }),
            importance: upcoming.impact,
            whenIso: upcoming.eventTimeIso,
          },
        };
      } else {
        val = { connected: true, next: null };
      }
    }
  } catch {
    val = { connected: false, next: null };
  }
  calCache = { at: Date.now(), val };
  return val;
}

/**
 * Gather the full Ruby context for a user. Never throws — each source is
 * isolated so a single failure degrades to a null/empty field.
 */
export async function buildRubyContext(
  userId: number,
  role: RubyRole,
  page: string,
  selectedSymbol: string | null,
): Promise<RubyContext> {
  const isPrivileged = role === "OWNER" || role === "ADMIN";
  const now = new Date();
  const serverUtcHour = now.getUTCHours();
  const warnings: string[] = [];

  const symbolRaw = (selectedSymbol ?? "").trim();
  const symbolUpper = symbolRaw ? symbolRaw.toUpperCase() : null;

  // ── Bridge + allocation (own slice; pool numbers privileged-only) ─────────
  let bridge: RubyContext["bridge"] = {
    availability: "UNAVAILABLE",
    connected: false,
    message: "Live bridge is not currently available.",
  };
  let account: RubyContext["account"] = { mt5: null, allocation: null, openPositions: null, openPL: null, snapshotFreshness: null, live: null };
  try {
    const view = await getUserAllocationView(userId);
    bridge = {
      availability: view.bridgeAvailability,
      connected: view.bridgeAvailability === "HEALTHY",
      message: view.bridgeMessage,
    };
    account.allocation = {
      allocated: view.assignedAllocation,
      available: view.availableAllocation,
      reserved: view.reservedRisk,
    };
    if (isPrivileged && view.pool) {
      account.mt5 = {
        balance: Number(view.pool.mt5Balance ?? 0),
        equity: Number(view.pool.mt5Equity ?? 0),
        openPnl: Number(view.pool.totalUserUnrealizedPnl ?? 0),
        currency: view.pool.accountCurrency ?? null,
        snapshotStatus: String(view.pool.snapshotStatus ?? "MISSING"),
      };
    }
  } catch {
    /* honest fall-through: bridge stays UNAVAILABLE */
  }

  // ── Open positions (user's own) ───────────────────────────────────────────
  // Reuse the SAME routing-aware truth source as getMyLiveOpenTrades (the
  // "analyze my open trades" path) so the briefing count can never contradict
  // it. Counting arx_live_positions directly leaked unreconciled / phantom
  // rows (broker-closed but not yet marked closed) and caused a "15 vs 2"
  // mismatch between the briefing and the trade analyzer.
  try {
    const { getMyLiveOpenTrades } = await import("./tools.js");
    const open = await getMyLiveOpenTrades(userId);
    account.openPositions = open.count;
  } catch {
    // Honest unknown — a failed lookup must NEVER read as "flat". The briefing
    // renders null as "I can't verify your open positions right now" (mirrors
    // the openPL null handling below), never as zero positions.
    account.openPositions = null;
  }

  // ── Open P/L via shared snapshot adapter (LIVE_SHARED users only) ────────
  // Same buildLiveAccountSnapshot adapter as the SSE stream and Dashboard so
  // Ruby's open P/L can never contradict what the Dashboard shows.
  // Non-live users (PAPER/DEMO/UNKNOWN) get null — never a fabricated value.
  // We apply the SAME live-mode visibility gate as /api/me/live/account-stream
  // (getUserModeScope → resolveLivePositionVisibility) so a PAPER user can
  // NEVER receive a "LIVE_SHARED"-labelled open P/L via Ruby's briefing.
  // Task #430 — read the canonical mark-to-market snapshot so Ruby's balance,
  // health, available, risk and "can I trade?" answers use the SAME numbers as
  // the user's Dashboard. The canonical builder applies the SAME live-mode
  // visibility gate (getUserModeScope → resolveLivePositionVisibility), so a
  // PAPER/DEMO/UNKNOWN user never receives a LIVE_SHARED-labelled figure.
  try {
    const { buildInvestorLiveBalanceSnapshot } = await import("../live/investorLiveBalance.js");
    const inv = await buildInvestorLiveBalanceSnapshot(userId);
    account.live = {
      source: inv.source,
      allocatedBalance: inv.allocatedBalance,
      realizedPnL: inv.realizedPnL,
      floatingPnL: inv.floatingPnL,
      liveEquity: inv.liveEquity,
      marginUsed: inv.marginUsed,
      freeMargin: inv.freeMargin,
      availableBalance: inv.availableBalance,
      openTradeCount: inv.openTradeCount,
      freshness: inv.freshness,
    };
    // openPL mirrors the underlying snapshot's openPL exactly (null when no
    // positions or all-unknown), preserving the prior briefing behaviour and
    // matching the Dashboard.
    if (inv.source === "live_shared" && inv.liveAccountSnapshot) {
      account.openPL = inv.liveAccountSnapshot.openPL;
      account.snapshotFreshness = inv.liveAccountSnapshot.freshness;
    }
    // For PAPER/DEMO/UNKNOWN: openPL and snapshotFreshness stay null (honest).
  } catch {
    // honest fall-through: openPL stays null, live stays null
  }

  // ── Market session ────────────────────────────────────────────────────────
  let session: RubyContext["session"] = null;
  try {
    const assetClass = symbolUpper ? classifySymbol(symbolUpper) : "unknown";
    const sa = analyzeSession(assetClass, symbolUpper ?? "");
    session = {
      name: sa.session,
      liquidity: sa.liquidityLevel,
      score: sa.sessionScore,
      forexOpen: assetClass === "synthetic" ? true : sa.session !== "Off-hours",
    };
  } catch {
    session = null;
  }

  // ── Symbol tradability ─────────────────────────────────────────────────────
  // Task #558 — ARX Focus lock: the briefing only reads an APPROVED market's
  // tradability/feed. An unapproved selected symbol stays null (honest absence),
  // so Ruby never analyzes or mentions an outside-universe market here.
  let symbol: RubyContext["symbol"] = null;
  if (symbolUpper && isApprovedArxMarket(symbolUpper)) {
    try {
      const t = await getSymbolTradability(symbolUpper, userId);
      // Shared chart-truth feed for the selected symbol — SAME resolver the chart
      // uses, so the briefing's source/quality/freshness match the chart exactly.
      // Best-effort: on resolver error we report null (honest), never fabricate.
      let marketFeed: NonNullable<RubyContext["symbol"]>["marketFeed"] = null;
      try {
        const { getSymbolSnapshot } = await import("../data/marketOverview.js");
        const snap = await getSymbolSnapshot(symbolUpper);
        marketFeed = {
          source: snap.source,
          quality: snap.quality,
          freshness: snap.freshness,
          aiUsable: snap.aiUsable,
          isLive: snap.isLive,
          lastPrice: snap.lastPrice,
        };
      } catch {
        marketFeed = null;
      }
      symbol = {
        symbol: t.symbol,
        tradable: t.mt5Tradable,
        badge: t.badgeLabel,
        assetClass: t.assetClass,
        marketFeed,
      };
    } catch {
      symbol = null;
    }
  }

  // ── Performance summary ────────────────────────────────────────────────────
  let performance: RubyContext["performance"] = { hasTrades: false };
  try {
    const s = await getTradeHistorySummary(userId);
    if (s.hasTrades) {
      performance = {
        hasTrades: true,
        count: s.count,
        closedCount: s.closedCount,
        winRate: s.winRate,
        netPnl: s.totalNetPnl,
      };
    }
  } catch {
    performance = { hasTrades: false };
  }

  // ── News + calendar (connected-only, cached) ───────────────────────────────
  const [news, calendar] = await Promise.all([fetchNews(symbolUpper), fetchCalendar()]);

  // ── Clean warnings (no internals) ──────────────────────────────────────────
  if (bridge.availability === "RECONCILING") {
    warnings.push("Live bridge is reconciling — execution may be briefly unavailable.");
  } else if (bridge.availability === "UNAVAILABLE") {
    warnings.push("Live bridge is offline right now.");
  }
  if (isPrivileged && account.mt5 && account.mt5.snapshotStatus === "STALE") {
    warnings.push("MT5 account snapshot is stale — refresh to re-sync.");
  }

  return {
    generatedAt: now.toISOString(),
    page: { key: page, label: pageLabel(page) },
    role,
    isPrivileged,
    timeOfDay: timeOfDayFromHour(now.getHours()),
    serverUtcHour,
    session,
    symbol,
    bridge,
    account,
    performance,
    news,
    calendar,
    weather: { available: false },
    location: { available: false },
    warnings,
  };
}

function fmtMoney(n: number, ccy: string | null): string {
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${ccy ? ccy + " " : "$"}${v}`;
}

function minutesUntil(iso: string): number {
  return Math.round((new Date(iso).getTime() - Date.now()) / 60000);
}

/**
 * Pure, deterministic honesty rule for Ruby's news-risk phrasing (Task #611).
 *
 * Provider-honesty-FIRST: when the news and/or economic-calendar feeds are not
 * connected, Ruby MUST report the risk as *unavailable* — it must NEVER imply
 * the news risk is low, calm, clear, or that there are no upcoming events. A
 * missing provider is honest absence, never fabricated reassurance. Returns
 * `null` when both feeds are connected (in which case the caller surfaces the
 * real headline/event lines instead).
 */
export function newsRiskStatement(
  newsConnected: boolean,
  calendarConnected: boolean,
): string | null {
  if (newsConnected && calendarConnected) return null;
  if (!newsConnected && !calendarConnected) {
    return "News and economic-calendar feeds aren't connected right now, so news risk is unavailable — I can't confirm it's calm and won't assume there are no events.";
  }
  if (!newsConnected) {
    return "The news feed isn't connected right now, so news risk is unavailable — I'm not treating that as no risk.";
  }
  return "The economic-calendar feed isn't connected right now, so upcoming events are unavailable — I'm not assuming none are scheduled.";
}

/**
 * Compose a compact plain-English briefing from a RubyContext. Deterministic
 * from state + time, so it naturally varies session-to-session and never
 * repeats an identical static greeting.
 */
export function composeRubyBriefing(ctx: RubyContext): RubyBriefing {
  const lines: string[] = [];

  // Headline — greets by time + live readiness.
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  let readiness: string;
  if (ctx.bridge.connected) readiness = "You're live-connected through Shared Master MT5.";
  else if (ctx.bridge.availability === "RECONCILING") readiness = "Your live bridge is reconciling right now.";
  else readiness = "Your live bridge is offline at the moment.";
  const headline = `Good ${ctx.timeOfDay}. ${readiness}`;

  // Session line.
  if (ctx.session) {
    if (ctx.session.forexOpen) {
      lines.push(
        `${ctx.session.name} session is active (${ctx.session.liquidity.toLowerCase()} liquidity).`,
      );
    } else {
      lines.push("Forex is closed right now — synthetic indices may still trade if your MT5 terminal supports them.");
    }
  }

  // Symbol line.
  if (ctx.symbol) {
    if (ctx.symbol.tradable === "yes") {
      lines.push(`${ctx.symbol.symbol} is tradable through the connected bridge if all live safety gates pass.`);
    } else if (ctx.symbol.tradable === "no") {
      lines.push(`${ctx.symbol.symbol} isn't live-executable on the current bridge — I can read its structure when live data for it is available.`);
    } else {
      lines.push(`${ctx.symbol.symbol} tradability isn't confirmed yet.`);
    }
    // Shared chart-truth feed line — same source/quality/freshness as the chart.
    const mf = ctx.symbol.marketFeed;
    if (mf) {
      if (mf.aiUsable && mf.freshness === "REALTIME") {
        lines.push(`Live data for ${ctx.symbol.symbol} is clean right now — I can read it confidently.`);
      } else {
        lines.push(`Live data for ${ctx.symbol.symbol} is ${mf.freshness.toLowerCase()} right now — I'll read it cautiously.`);
      }
    }
  }

  // Positions / account.
  if (ctx.account.openPositions == null) {
    // Honest unknown — the open-trades lookup failed. Never say "no positions"
    // on a failed read: the account may hold live broker positions right now.
    lines.push("I can't verify your open positions right now — the lookup didn't come back, so I won't assume you're flat.");
  } else if (ctx.account.openPositions > 0) {
    lines.push(
      `You have ${ctx.account.openPositions} open position${ctx.account.openPositions === 1 ? "" : "s"} right now.`,
    );
    // Open P/L — same adapter as Dashboard/Open Trades; honest freshness qualifier.
    if (ctx.account.openPL != null) {
      const fresh = ctx.account.snapshotFreshness;
      const freshnessNote =
        fresh === "live" || fresh === "fresh" ? "" :
        fresh === "delayed" ? " (slightly delayed)" :
        fresh === "stale" ? " (last known — may be stale)" : "";
      lines.push(`Open floating P/L: ${fmtMoney(ctx.account.openPL, null)}${freshnessNote}.`);
    }
  } else {
    lines.push("No positions are currently open.");
  }
  if (ctx.isPrivileged && ctx.account.mt5) {
    lines.push(
      `Master MT5: balance ${fmtMoney(ctx.account.mt5.balance, ctx.account.mt5.currency)}, ` +
        `equity ${fmtMoney(ctx.account.mt5.equity, ctx.account.mt5.currency)}, ` +
        `open P/L ${fmtMoney(ctx.account.mt5.openPnl, ctx.account.mt5.currency)}.`,
    );
  } else if (ctx.account.allocation && ctx.account.allocation.allocated > 0) {
    lines.push(
      `Your ARX allocation: ${fmtMoney(ctx.account.allocation.available, null)} available of ` +
        `${fmtMoney(ctx.account.allocation.allocated, null)}.`,
    );
  }

  // Economic calendar (connected-only).
  if (ctx.calendar.connected && ctx.calendar.next) {
    const mins = minutesUntil(ctx.calendar.next.whenIso);
    if (mins >= 0 && mins <= 240) {
      lines.push(
        `${ctx.calendar.next.region} ${ctx.calendar.next.title} is due in about ${mins} minute${mins === 1 ? "" : "s"} — entries may be noisy around the release.`,
      );
    }
  }

  // News (connected-only). Report the REAL severity-derived risk level — never
  // a fabricated "calm". Honest absence is handled by newsRiskStatement below.
  if (ctx.news.connected) {
    if (ctx.news.riskLevel !== "unavailable") {
      const riskPhrase: Record<Exclude<MarketHeatNewsRiskLevel, "unavailable">, string> = {
        high: "News risk is high right now — active high-impact headlines.",
        elevated: "News risk is elevated right now — notable headline activity.",
        moderate: "News risk is moderate right now — some headline activity.",
        low: "News risk reads low right now — quiet headline flow.",
      };
      lines.push(riskPhrase[ctx.news.riskLevel]);
    }
    if (ctx.news.items.length > 0) {
      lines.push(`Latest headline: ${ctx.news.items[0]!.headline} (${ctx.news.items[0]!.source}).`);
    }
  }

  // Honest absence — when news/calendar feeds aren't connected, say risk is
  // unavailable. NEVER imply it's low/calm or that no events are scheduled.
  const riskNote = newsRiskStatement(ctx.news.connected, ctx.calendar.connected);
  if (riskNote) lines.push(riskNote);

  // Performance (only when meaningful).
  if (ctx.performance.hasTrades && ctx.performance.closedCount && ctx.performance.closedCount > 0) {
    lines.push(
      `Recent record: ${ctx.performance.winRate}% win rate across ${ctx.performance.closedCount} closed trades.`,
    );
  }

  // Warnings (clean).
  for (const w of ctx.warnings) lines.push(w);

  // Setup guidance — state-gated so solved steps don't repeat.
  let setupGuidance: string | null = null;
  if (!ctx.bridge.connected && ctx.bridge.availability === "UNAVAILABLE") {
    setupGuidance = "Your live bridge isn't connected yet — open MT5 Setup to check your connection.";
  }

  return {
    headline,
    lines,
    setupGuidance,
    suggestions: buildSuggestions(ctx),
    updatedAt: ctx.generatedAt,
    mode: cap(ctx.page.label),
  };
}

// Page-aware, state-aware rotating suggestions. Picks 4, rotated by the
// current minute so they don't look frozen, but always contextually valid.
function buildSuggestions(ctx: RubyContext): Array<{ label: string; prompt: string }> {
  const pool: Array<{ label: string; prompt: string }> = [];
  const sym = ctx.symbol?.symbol;

  if (ctx.page.label === "Scanner") {
    pool.push({ label: "Scan live setups", prompt: "Scan for high-probability live setups right now." });
    if (sym) pool.push({ label: `Read ${sym}`, prompt: `Read the ${sym} chart and tell me the structure.` });
    if (sym) pool.push({ label: `Is ${sym} tradable?`, prompt: `Is ${sym} tradable through the bridge right now?` });
  } else if (ctx.page.label === "Cockpit") {
    pool.push({ label: "Account status", prompt: "What is my account and live bridge status right now?" });
    pool.push({ label: "Today's performance", prompt: "Review my trading performance so far." });
  } else if (ctx.page.label === "Trades") {
    pool.push({ label: "Check my open trades", prompt: "Summarize my open trades and any risk I should watch." });
  }

  // Always-relevant context options.
  pool.push({ label: "What changed in the market?", prompt: "What has changed in the market that I should know about?" });
  pool.push({ label: "Check news risk", prompt: "Is there any news risk I should be aware of before trading?" });
  pool.push({ label: "Explain my risk", prompt: "Explain my current risk limits in plain English." });
  // Strict === 0 on purpose: null means the lookup failed (unknown), and we
  // don't pitch "find a setup" to someone whose exposure we couldn't read.
  if (ctx.account.openPositions === 0) {
    pool.push({ label: "Find a setup", prompt: "Help me find a high-probability setup to consider." });
  }

  // Dedup by label, then rotate.
  const seen = new Set<string>();
  const unique = pool.filter((s) => (seen.has(s.label) ? false : (seen.add(s.label), true)));
  const offset = new Date().getMinutes() % Math.max(1, unique.length);
  const rotated = [...unique.slice(offset), ...unique.slice(0, offset)];
  return rotated.slice(0, 4);
}
