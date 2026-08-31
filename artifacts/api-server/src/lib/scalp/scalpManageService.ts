// Ruby Flame Scalp — manage-side service (Phase 2).
//
// Turns the user's ALREADY-OPEN positions into scalp baskets with live,
// direction-aligned flame reads, exit-urgency and add-on guidance, and
// maintains the short failed-flame lockout that tightens same-direction reads.
//
// SAFETY:
//  - Per-user isolation: open positions, specs, execution and lockouts are all
//    read/written scoped by userId. No row from another user is ever returned.
//  - Mode-scoped: a LIVE_SHARED user only sees LIVE rows; a DEMO user only DEMO.
//    PAPER/NONE users get no baskets here.
//  - ADVICE ONLY: nothing in this module places, modifies, sizes or closes a
//    real order. Exit verdicts are ALERT_ONLY; add-on verdicts are guidance.
//  - No fabrication: candles are real or the flame reads blind (honest NONE);
//    prices come from the live router or the position's own broker fields.
//  - The lockout only ever TIGHTENS advice (downgrades an actionable read); it
//    never loosens a gate, and is purely per-user + per-symbol + per-direction.

import { and, eq, gt, sql } from "drizzle-orm";
import {
  db,
  arxLivePositionsTable,
  mt5StateTable,
  scalpFlameLockoutsTable,
} from "@workspace/db";
import { getUserModeScope } from "../modeScope/getUserModeScope.js";
import { readFlame, finalizeScalpVerdict } from "./flameRead.js";
import { getSymbolInfo } from "../../brain/symbols/symbolRegistry.js";
import {
  assembleBasket,
  basketSyncInfo,
  evaluateAddOn,
  groupLegsIntoBaskets,
  summarizeBasket,
  BASKET_SYNC_STALE_MS,
  FAILED_FLAME_LOCKOUT_MS,
  type OpenPositionInput,
} from "./scalpManage.js";
import {
  candleWindowFor,
  currentPriceFor,
  loadExecutionInput,
  loadSpecInput,
  deriveHtfBias,
  SCALP_TIMEFRAME,
} from "./scalpServiceInputs.js";
import { buildEntrySnapshot, isSyntheticSymbol } from "./scalpJournal.js";
import {
  recordScalpBasketsObservation,
  type JournalAccountMode,
  type ObservationSnapshot,
} from "./scalpJournalService.js";
import type {
  RiskPersonality,
  ScalpAddOnVerdict,
  ScalpBasket,
  ScalpCandle,
  ScalpDirection,
  ScalpExecutionInput,
  ScalpFlameRead,
  ScalpSpecInput,
} from "./scalpTypes.js";

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export type ManageAccountMode = "LIVE_SHARED" | "DEMO" | "PAPER" | "NONE";

type DemoRaw = {
  ticket?: string | number | null;
  symbol?: string | null;
  side?: "BUY" | "SELL" | null;
  lot?: number | null;
  volume?: number | null;
  openPrice?: number | null;
  currentPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  profit?: number | null;
  openTime?: string | null;
};

/**
 * Load the user's open positions, strictly mode-scoped (mirrors the unified
 * positions feed). Returns the rows already mapped to the pure module's
 * OpenPositionInput shape, the resolved account mode for the response, and
 * `lastSyncedAtMs` — the newest broker sync time for the mode's feed (null
 * when the feed never reported one). Callers MUST judge freshness against
 * NOW via that value (basketSyncInfo): the intra-feed filter below is only
 * relative to the newest row, so when the bridge is down ALL rows are
 * equally old and all pass — the feed-level stamp is what makes that
 * staleness visible instead of silently rendering hours-old rows as live.
 */
async function loadOpenPositions(
  userId: number,
  isAdmin: boolean,
): Promise<{
  positions: OpenPositionInput[];
  accountMode: ManageAccountMode;
  lastSyncedAtMs: number | null;
}> {
  const scope = await getUserModeScope(userId, { isAdmin });
  const mode = scope.currentAccountMode;
  const includeLive = mode === "LIVE_SHARED";
  const includeDemo = mode === "DEMO";

  const accountMode: ManageAccountMode = includeLive
    ? "LIVE_SHARED"
    : includeDemo
    ? "DEMO"
    : mode === "PAPER"
    ? "PAPER"
    : "NONE";

  const positions: OpenPositionInput[] = [];
  let lastSyncedAtMs: number | null = null;

  if (includeLive) {
    const liveRowsAll = await db.select().from(arxLivePositionsTable)
      .where(eq(arxLivePositionsTable.userId, userId));
    const newestLiveSync = liveRowsAll.reduce((max, r) => {
      const t = r.lastSyncedAt ? new Date(r.lastSyncedAt).getTime() : 0;
      return t > max ? t : max;
    }, 0);
    if (newestLiveSync > 0) lastSyncedAtMs = newestLiveSync;
    // Relative straggler filter only: drops rows the bridge stopped refreshing
    // while OTHERS kept syncing. It says nothing about feed-level freshness —
    // that is judged against NOW via lastSyncedAtMs above.
    const liveFloor = newestLiveSync > 0 ? newestLiveSync - BASKET_SYNC_STALE_MS : 0;
    for (const r of liveRowsAll) {
      if (r.closedAt) continue;
      const t = r.lastSyncedAt ? new Date(r.lastSyncedAt).getTime() : 0;
      if (t < liveFloor) continue;
      positions.push({
        ticket: r.brokerTicket ?? null,
        symbol: r.symbol,
        displayName: getSymbolInfo(r.symbol)?.displayName ?? r.symbol,
        side: r.side,
        volume: num(Number(r.volume)) ? Number(r.volume) : null,
        entryPrice: num(Number(r.entryPrice)) ? Number(r.entryPrice) : null,
        currentPrice: r.currentPrice != null ? Number(r.currentPrice) : null,
        floatingPl: r.floatingPl != null ? Number(r.floatingPl) : null,
        stopLoss: r.stopLoss != null ? Number(r.stopLoss) : null,
        takeProfit: r.takeProfit != null ? Number(r.takeProfit) : null,
        openedAt: r.openedAt instanceof Date ? r.openedAt.toISOString() : (r.openedAt ? String(r.openedAt) : null),
        accountMode: "LIVE",
      });
    }
  }

  if (includeDemo) {
    const stateRows = await db.select().from(mt5StateTable)
      .where(eq(mt5StateTable.userId, userId))
      .orderBy(sql`${mt5StateTable.lastSyncAt} DESC NULLS LAST`)
      .limit(1);
    // The DEMO path previously had NO age signal at all — the newest state row
    // was served as current however old it was. Surface its sync time so the
    // caller can label an hours-old snapshot honestly instead of "live".
    const demoSync = stateRows[0]?.lastSyncAt ? new Date(stateRows[0]!.lastSyncAt).getTime() : NaN;
    if (Number.isFinite(demoSync) && demoSync > 0) lastSyncedAtMs = demoSync;
    const raw: DemoRaw[] = Array.isArray(stateRows[0]?.positions)
      ? (stateRows[0]!.positions as DemoRaw[]) : [];
    for (const p of raw) {
      const symbol = p.symbol ?? null;
      if (!symbol) continue;
      positions.push({
        ticket: p.ticket == null ? null : String(p.ticket),
        symbol,
        displayName: getSymbolInfo(symbol)?.displayName ?? symbol,
        side: p.side ?? null,
        volume: num(p.lot ?? p.volume) ? (p.lot ?? p.volume)! : null,
        entryPrice: num(p.openPrice) ? p.openPrice! : null,
        currentPrice: num(p.currentPrice) ? p.currentPrice! : null,
        floatingPl: num(p.profit) ? p.profit! : null,
        stopLoss: num(p.stopLoss) ? p.stopLoss! : null,
        takeProfit: num(p.takeProfit) ? p.takeProfit! : null,
        openedAt: p.openTime ?? null,
        accountMode: "DEMO",
      });
    }
  }

  return { positions, accountMode, lastSyncedAtMs };
}

/** Point size from broker spec digits when the spec doesn't carry `point`. */
function pointFor(spec: ScalpSpecInput): number {
  if (num(spec.point) && spec.point > 0) return spec.point;
  if (num(spec.digits) && spec.digits >= 0) return Math.pow(10, -spec.digits);
  return 0.0001;
}

interface BasketGeometry {
  averageEntry: number;
  currentPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

/**
 * Build a direction-aligned flame read for an OPEN position. Unlike the entry
 * engine (which derives direction from the scanner), the manage side always
 * reads the flame in the basket's OWN direction so exit/add-on guidance reflects
 * the side the user is actually holding. Real candles or an honest blind read.
 */
function readManageFlame(
  direction: ScalpDirection,
  candles: ScalpCandle[] | null,
  spec: ScalpSpecInput,
  execution: ScalpExecutionInput | null,
  geo: BasketGeometry,
  personality: RiskPersonality,
): ScalpFlameRead {
  const point = pointFor(spec);
  const digits = num(spec.digits) ? spec.digits : 5;
  const spreadPrice = num(spec.spreadPoints) ? spec.spreadPoints * point : 0;
  const sign = direction === "BUY" ? 1 : -1;

  const entry = geo.averageEntry;
  const stopDist = num(geo.stopLoss) ? Math.abs(entry - geo.stopLoss) : Math.max(point * 100, spreadPrice * 10);
  const mainTpDist = num(geo.takeProfit)
    ? Math.abs(geo.takeProfit - entry)
    : Math.max(stopDist * 1.5, point * 150);
  const movedToward = sign * (geo.currentPrice - entry);
  const lateFraction = mainTpDist > 0 ? Math.max(-1, Math.min(1.5, movedToward / mainTpDist)) : 0;
  const invalidationPrice = num(geo.stopLoss) ? geo.stopLoss : entry - sign * stopDist;
  const mainTpPrice = num(geo.takeProfit) ? geo.takeProfit : entry + sign * mainTpDist;
  const quickTpPrice = entry + sign * mainTpDist * 0.5;

  const core = readFlame({
    direction,
    candles,
    price: geo.currentPrice,
    point,
    spreadPrice,
    stopDist,
    mainTpDist,
    quickTpDist: Math.abs(quickTpPrice - entry),
    lateFraction,
    inZone: false,
    execution,
    htfBias: deriveHtfBias(candles),
    personality,
    scannerReason: null,
    scannerSetupType: null,
    invalidationPrice,
    quickTpPrice,
    mainTpPrice,
    digits,
  });

  if (core.blind) return core.read;

  // Map the flame's own downgrade into an engine-style status, then finalize the
  // user-facing scalpStatus / readDirection / score the same way the engine does.
  // A neutral score base + flame adjustment keeps STRONG/POSSIBLE/WEAK banding
  // consistent with the entry surface without re-running the full scanner.
  const kind = core.downgrade.kind;
  const status =
    kind === "NO_SCALP" ? "NO_CLEAN_SCALP"
    : kind === "LATE" ? "LATE"
    : kind === "FORMING" ? "FORMING"
    : "READY";
  const qualityScore = Math.max(0, Math.min(100, Math.round(60 + core.scoreAdjust)));

  return finalizeScalpVerdict(core.read, { status, qualityScore, direction, personality });
}

// ── Failed-flame lockout persistence (per-user) ────────────────────────────

/** Active (unexpired) lockout directions for a symbol, scoped to the user. */
async function activeLockoutDirections(userId: number, symbol: string): Promise<Set<ScalpDirection>> {
  const rows = await db.select({ direction: scalpFlameLockoutsTable.direction })
    .from(scalpFlameLockoutsTable)
    .where(and(
      eq(scalpFlameLockoutsTable.userId, userId),
      eq(scalpFlameLockoutsTable.symbol, symbol),
      gt(scalpFlameLockoutsTable.expiresAt, new Date()),
    ));
  const out = new Set<ScalpDirection>();
  for (const r of rows) {
    if (r.direction === "BUY" || r.direction === "SELL") out.add(r.direction);
  }
  return out;
}

/** Upsert (refresh + bump) a short failed-flame lockout for symbol+direction. */
async function upsertFailedFlameLockout(
  userId: number,
  symbol: string,
  direction: ScalpDirection,
  reason: string,
  now: number = Date.now(),
): Promise<void> {
  const expiresAt = new Date(now + FAILED_FLAME_LOCKOUT_MS);
  await db.insert(scalpFlameLockoutsTable).values({
    userId, symbol, direction, reason,
    repeatCount: 1,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    expiresAt,
  }).onConflictDoUpdate({
    target: [scalpFlameLockoutsTable.userId, scalpFlameLockoutsTable.symbol, scalpFlameLockoutsTable.direction],
    set: {
      reason,
      updatedAt: new Date(now),
      expiresAt,
      repeatCount: sql`${scalpFlameLockoutsTable.repeatCount} + 1`,
    },
  });
}

export interface GetScalpBasketsResult {
  baskets: ScalpBasket[];
  accountMode: ManageAccountMode;
  generatedAt: string;
}

/**
 * Group the user's open positions into scalp baskets with live flame, exit and
 * add-on guidance. Side effect: when a basket's flame has FAILED, a short
 * same-direction lockout is recorded so the entry surface tightens that side.
 */
export async function getScalpBaskets(
  userId: number,
  opts: { isAdmin?: boolean; riskPersonality?: RiskPersonality | null } = {},
): Promise<GetScalpBasketsResult> {
  const personality = opts.riskPersonality ?? "BALANCED";
  const { positions, accountMode, lastSyncedAtMs } = await loadOpenPositions(userId, opts.isAdmin ?? false);
  const groups = groupLegsIntoBaskets(positions);
  const now = Date.now();
  // Feed-level freshness vs NOW (not vs the newest row) — when the bridge is
  // down this flags EVERY basket as "as of syncedAt" instead of letting
  // hours-old open positions and P/L render as current.
  const sync = basketSyncInfo(lastSyncedAtMs, now);

  const built = await Promise.all(groups.map(async (g) => {
    const [spec, candles, livePrice, execution] = await Promise.all([
      loadSpecInput(userId, g.symbol),
      candleWindowFor(g.symbol),
      currentPriceFor(g.symbol),
      loadExecutionInput(userId),
    ]);
    const summary = summarizeBasket(g.legs);
    const currentPrice = num(livePrice) ? livePrice : summary.currentPrice;
    const flame = readManageFlame(
      g.direction, candles, spec, execution,
      {
        averageEntry: summary.averageEntry,
        currentPrice: num(currentPrice) ? currentPrice : summary.averageEntry,
        stopLoss: g.legs.find((l) => num(l.stopLoss))?.stopLoss ?? null,
        takeProfit: g.legs.find((l) => num(l.takeProfit))?.takeProfit ?? null,
      },
      personality,
    );
    const basket = assembleBasket(g, flame, { personality, currentPrice, now, sync });
    return { basket, spec, execution };
  }));

  const baskets = built.map((b) => b.basket);

  // Side effect: record same-direction lockouts for any failed flame (per-user).
  await Promise.all(baskets
    .filter((b) => b.flame.flameStage === "FAILED")
    .map((b) => upsertFailedFlameLockout(
      userId, b.symbol, b.direction,
      "A recent burst on this side failed — same-direction reads are cooled down briefly.",
      now,
    )));

  // Side effect: journal the lifecycle of every open basket (and finalize any
  // that have since closed). Per-user, advisory, best-effort. LIVE/DEMO only.
  if (accountMode === "LIVE_SHARED" || accountMode === "DEMO") {
    const journalMode: JournalAccountMode = accountMode;
    const snapshots: ObservationSnapshot[] = built.map(({ basket, spec, execution }) => {
      const snap = buildEntrySnapshot(basket, {
        accountMode: journalMode,
        timeframe: SCALP_TIMEFRAME,
        scalpMode: null,
        spreadPoints: num(execution?.liveSpreadPoints)
          ? execution!.liveSpreadPoints!
          : (num(spec.spreadPoints) ? spec.spreadPoints : null),
        executionLatencySeconds: execution?.heartbeatAgeSeconds ?? null,
      });
      return {
        ...snap,
        isSynthetic: isSyntheticSymbol(basket.symbol, spec.category ?? null),
        legTickets: basket.legs.map((l) => l.ticket).filter((t): t is string => !!t),
      };
    });
    await recordScalpBasketsObservation(userId, journalMode, snapshots);
  }

  return {
    baskets,
    accountMode,
    generatedAt: new Date(now).toISOString(),
  };
}

export interface GetAddOnCheckArgs {
  symbol: string;
  direction: ScalpDirection;
  riskPersonality?: RiskPersonality | null;
}

export interface GetAddOnCheckResult {
  symbol: string;
  direction: ScalpDirection;
  hasOpenBasket: boolean;
  basket: ScalpBasket | null;
  addOn: ScalpAddOnVerdict;
  flame: ScalpFlameRead;
  generatedAt: string;
}

/**
 * Add-on guidance for a symbol+direction: how much (0..3 / never) it is sane to
 * add, with the revenge guard + profit-cushion check. Advice only. When the
 * user already has an open basket on that side we aggregate it; otherwise we
 * return fresh-entry guidance with no open legs.
 */
export async function getAddOnCheck(
  userId: number,
  args: GetAddOnCheckArgs,
  opts: { isAdmin?: boolean } = {},
): Promise<GetAddOnCheckResult> {
  const personality = args.riskPersonality ?? "BALANCED";
  const { positions, lastSyncedAtMs } = await loadOpenPositions(userId, opts.isAdmin ?? false);
  const groups = groupLegsIntoBaskets(positions);
  const symU = args.symbol.trim().toUpperCase();
  const group = groups.find(
    (g) => g.symbol.toUpperCase() === symU && g.direction === args.direction,
  ) ?? null;
  const now = Date.now();

  const [spec, candles, livePrice, execution] = await Promise.all([
    loadSpecInput(userId, group?.symbol ?? args.symbol),
    candleWindowFor(group?.symbol ?? args.symbol),
    currentPriceFor(group?.symbol ?? args.symbol),
    loadExecutionInput(userId),
  ]);

  const summary = group ? summarizeBasket(group.legs) : summarizeBasket([]);
  const refPrice = num(livePrice) ? livePrice : (num(summary.currentPrice) ? summary.currentPrice : summary.averageEntry);
  const flame = readManageFlame(
    args.direction, candles, spec, execution,
    {
      averageEntry: group ? summary.averageEntry : (num(refPrice) ? refPrice : 0),
      currentPrice: num(refPrice) ? refPrice : 0,
      stopLoss: group?.legs.find((l) => num(l.stopLoss))?.stopLoss ?? null,
      takeProfit: group?.legs.find((l) => num(l.takeProfit))?.takeProfit ?? null,
    },
    personality,
  );

  const basket = group
    ? assembleBasket(group, flame, {
        personality,
        currentPrice: refPrice,
        now,
        sync: basketSyncInfo(lastSyncedAtMs, now),
      })
    : null;
  const addOn = basket ? basket.addOn : evaluateAddOn(flame, summary, personality);

  // Populate addOnsBlockedReason on the admin trace when the add-on is blocked
  // specifically because of poor run-on quality (qualityScore < 0.3 → DO_NOT_ADD).
  // This enriches the trace only for admin views — the trace is stripped for
  // normal users at the route layer (meScalp.ts redactFlameTrace).
  let enrichedFlame = flame;
  if (
    flame.flameStage === "RUN_ON" &&
    flame.runOnTrace &&
    flame.runOnTrace.qualityScore < 0.3 &&
    addOn.recommendation === "DO_NOT_ADD"
  ) {
    enrichedFlame = {
      ...flame,
      runOnTrace: {
        ...flame.runOnTrace,
        addOnsBlockedReason:
          `Run-on quality score (${flame.runOnTrace.qualityScore.toFixed(2)}) is below the ` +
          `minimum threshold — choppy or wick-heavy burst disqualifies adds at this stage.`,
      },
    };
  }

  return {
    symbol: group?.symbol ?? args.symbol,
    direction: args.direction,
    hasOpenBasket: group != null,
    basket,
    addOn,
    flame: enrichedFlame,
    generatedAt: new Date(now).toISOString(),
  };
}

/**
 * Active lockout directions for a symbol (per-user). Used by the entry Focus
 * path to set `recentFailureLockout` so a just-failed side is cooled down.
 */
export async function getActiveLockoutDirections(userId: number, symbol: string): Promise<Set<ScalpDirection>> {
  return activeLockoutDirections(userId, symbol);
}
