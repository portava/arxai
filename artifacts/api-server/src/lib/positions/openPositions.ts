/**
 * The canonical read model for a trader's open broker exposure.
 *
 * "What are this user's open positions?" is answered here, once, for both
 * physical schemas the ledger owns:
 *   LIVE → arx_live_positions (the live pipeline's broker snapshot)
 *   DEMO → live_positions     (the DEMO / legacy EA mirror)
 *
 * The two tables are still physically separate (see
 * docs/TIER1_OPEN_POSITION_VIEW.md). This module does not merge them; it gives
 * every caller one venue selection, one set of named "open" definitions, one
 * per-user predicate and one normalised row shape, built on the ledger.
 *
 * SAFETY:
 *   - Read-only. No writes, no broker commands, no trade authority.
 *   - readOpenPositions / countOpenPositions / select*OpenPositions are always
 *     scoped to exactly one user id. The only cross-user reads are the
 *     separately named select*OpenPositionsForAllUsers functions, which exist
 *     for operator views and sweeps; CI restricts their importers to an
 *     allowlist (scripts/src/ci/check-single-open-position-view.ts).
 *   - Mode scope is optional and fail-closed: when a scope is supplied, a venue
 *     the mode does not show is never queried.
 *   - A supplied executor (transaction / advisory-lock connection) is used as
 *     given and never replaced by the global db.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, SelectedFields } from "drizzle-orm/pg-core";
import type { db } from "@workspace/db";
import {
  demoPositionColumns,
  demoPositionLedger,
  livePositionColumns,
  livePositionLedger,
  type DemoPositionRow,
  type LivePositionRow,
} from "./ledger.js";
import { openLiveExposureCondition } from "../live/livePositionExposure.js";
import { resolveLivePositionVisibility } from "../modeScope/livePositionVisibility.js";
import type { CurrentAccountMode } from "../computeAccountModePrecedence.js";

export type OpenPositionVenue = "LIVE" | "DEMO";
export type OpenPositionVenueSelector = OpenPositionVenue | "ALL";

/**
 * Which rows count as "open". These are the three definitions the runtime
 * already used; naming them makes the choice explicit at every call site.
 *
 * | basis          | LIVE (arx_live_positions)                       | DEMO (live_positions) |
 * |----------------|-------------------------------------------------|-----------------------|
 * | EXPOSURE       | closed_at IS NULL AND reconcile_state IS NULL   | status <> 'CLOSED'    |
 * | UNCLOSED       | closed_at IS NULL                               | status <> 'CLOSED'    |
 * | CONFIRMED_OPEN | closed_at IS NULL AND reconcile_state IS NULL   | status = 'OPEN'       |
 *
 * EXPOSURE is the default and is the canonical live-exposure predicate
 * (`openLiveExposureCondition`). UNCLOSED is the conservative superset the Risk
 * Governor and the assistant's position lookups use: an operator-reconciled
 * IGNORED / EXTERNAL row may still be standing at the broker, so it keeps
 * counting there. CONFIRMED_OPEN excludes DEMO rows that are still SYNC_PENDING
 * or carry a hit/terminal status; it is used where advice or a list is shown.
 */
export type OpenPositionBasis = "EXPOSURE" | "UNCLOSED" | "CONFIRMED_OPEN";

/**
 * LIVE-only addition for the projected reads: UNCLOSED_RECONCILED is
 * `closed_at IS NULL AND reconcile_state IS NOT NULL`, i.e. exactly the rows
 * UNCLOSED adds on top of EXPOSURE (operator-reconciled IGNORED / EXTERNAL /
 * IMPORTED ghosts). It carries no live exposure; it exists for the operator
 * ghost drill-down. DEMO rows have no reconcile state, so it is LIVE-only.
 */
export type LiveOpenPositionBasis = OpenPositionBasis | "UNCLOSED_RECONCILED";

interface OpenPositionCommon {
  /** Row id in the venue's own table (ids are NOT comparable across venues). */
  id: number;
  userId: number;
  symbol: string;
  /** BUY | SELL as recorded by the broker sync (not re-validated here). */
  side: string;
  lots: number;
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  currentPrice: number | null;
  floatingPnl: number | null;
  /** Broker open time. DEMO rows may not carry one. */
  openedAt: Date | null;
  /** When ARX first recorded the row (created_at). */
  recordedAt: Date;
  /** Last broker snapshot that touched the row (last_synced_at). */
  observedAt: Date | null;
}

export interface LiveOpenPosition extends OpenPositionCommon {
  venue: "LIVE";
  ticket: string;
  /** The governed command that opened it; null for orphans / external rows. */
  sourceCommandId: string | null;
  bridgeConnectionId: number;
  /** "OPEN", or the operator reconcile state (only possible under UNCLOSED). */
  status: string;
  /** The ledger row, for venue-specific fields the normalised shape omits. */
  row: LivePositionRow;
}

export interface DemoOpenPosition extends OpenPositionCommon {
  venue: "DEMO";
  ticket: string | null;
  /** live_positions carries no command link. */
  sourceCommandId: null;
  bridgeConnectionId: null;
  status: string;
  row: DemoPositionRow;
}

export type OpenPosition = LiveOpenPosition | DemoOpenPosition;

type Reader = Pick<typeof db, "select" | "selectDistinct">;

export interface ReadOpenPositionsOptions<V extends OpenPositionVenueSelector = OpenPositionVenueSelector> {
  /** The one user whose positions are read. Required; never widened. */
  userId: number;
  venue: V;
  basis?: OpenPositionBasis;
  /**
   * When supplied, venues the resolved account mode does not show are dropped
   * before any query (LIVE only in LIVE_SHARED, DEMO only in DEMO). Omit it
   * only where the venue is already authoritative (e.g. an order intent's venue).
   */
  modeScope?: { currentAccountMode: CurrentAccountMode };
  symbol?: string;
  /** Restrict to these broker tickets. An empty list matches nothing. */
  tickets?: readonly string[];
  /** LIVE only: restrict to one bridge connection. */
  bridgeConnectionId?: number;
  /** Default "id" (ascending). "openedAtDesc" is newest first, id as tie-break. */
  order?: "id" | "openedAtDesc";
  /** Per venue. */
  limit?: number;
  executor?: Reader;
}

type ResultFor<V extends OpenPositionVenueSelector> = V extends "LIVE"
  ? LiveOpenPosition
  : V extends "DEMO"
    ? DemoOpenPosition
    : OpenPosition;

/** The venues a resolved account mode shows (the unified feed's rule). */
export function openPositionVenuesForMode(mode: CurrentAccountMode): OpenPositionVenue[] {
  const venues: OpenPositionVenue[] = [];
  if (resolveLivePositionVisibility(mode).includeLive) venues.push("LIVE");
  if (mode === "DEMO") venues.push("DEMO");
  return venues;
}

function requireUserId(userId: number): number {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error("readOpenPositions requires a positive integer userId");
  }
  return userId;
}

function selectedVenues(opts: ReadOpenPositionsOptions): OpenPositionVenue[] {
  const requested: OpenPositionVenue[] = opts.venue === "ALL" ? ["LIVE", "DEMO"] : [opts.venue];
  if (opts.bridgeConnectionId != null && requested.includes("DEMO")) {
    throw new Error("bridgeConnectionId filters LIVE positions only");
  }
  if (!opts.modeScope) return requested;
  const allowed = openPositionVenuesForMode(opts.modeScope.currentAccountMode);
  return requested.filter((v) => allowed.includes(v));
}

/** The LIVE predicate for a basis; exported for SQL aggregates that must match. */
export function liveOpenCondition(userId: number, basis: LiveOpenPositionBasis = "EXPOSURE"): SQL {
  requireUserId(userId);
  if (basis === "UNCLOSED_RECONCILED") {
    return and(
      eq(livePositionColumns.userId, userId),
      isNull(livePositionColumns.closedAt),
      isNotNull(livePositionColumns.reconcileState),
    )!;
  }
  return basis === "UNCLOSED"
    ? and(eq(livePositionColumns.userId, userId), isNull(livePositionColumns.closedAt))!
    : openLiveExposureCondition(userId);
}

/** The DEMO predicate for a basis; exported for SQL aggregates that must match. */
export function demoOpenCondition(userId: number, basis: OpenPositionBasis = "EXPOSURE"): SQL {
  requireUserId(userId);
  return and(
    eq(demoPositionColumns.userId, userId),
    basis === "CONFIRMED_OPEN"
      ? eq(demoPositionColumns.status, "OPEN")
      : ne(demoPositionColumns.status, "CLOSED"),
  )!;
}

function liveWhere(opts: ReadOpenPositionsOptions): SQL {
  const conds: SQL[] = [liveOpenCondition(opts.userId, opts.basis)];
  if (opts.symbol !== undefined) conds.push(eq(livePositionColumns.symbol, opts.symbol));
  if (opts.tickets !== undefined) conds.push(inArray(livePositionColumns.brokerTicket, [...opts.tickets]));
  if (opts.bridgeConnectionId !== undefined) {
    conds.push(eq(livePositionColumns.bridgeConnectionId, opts.bridgeConnectionId));
  }
  return and(...conds)!;
}

function demoWhere(opts: ReadOpenPositionsOptions): SQL {
  const conds: SQL[] = [demoOpenCondition(opts.userId, opts.basis)];
  if (opts.symbol !== undefined) conds.push(eq(demoPositionColumns.symbol, opts.symbol));
  if (opts.tickets !== undefined) conds.push(inArray(demoPositionColumns.brokerPositionId, [...opts.tickets]));
  return and(...conds)!;
}

function orderFor(
  order: ReadOpenPositionsOptions["order"],
  cols: { id: AnyPgColumn; openedAt: AnyPgColumn },
): SQL[] {
  return order === "openedAtDesc" ? [desc(cols.openedAt), desc(cols.id)] : [asc(cols.id)];
}

export function liveOpenPosition(r: LivePositionRow): LiveOpenPosition {
  return {
    venue: "LIVE",
    id: r.id,
    userId: r.userId,
    ticket: r.brokerTicket,
    symbol: r.symbol,
    side: r.side,
    lots: r.volume,
    entryPrice: r.entryPrice,
    stopLoss: r.stopLoss,
    takeProfit: r.takeProfit,
    currentPrice: r.currentPrice,
    floatingPnl: r.floatingPl,
    openedAt: r.openedAt,
    recordedAt: r.createdAt,
    observedAt: r.lastSyncedAt,
    sourceCommandId: r.sourceCommandId,
    bridgeConnectionId: r.bridgeConnectionId,
    status: r.reconcileState ?? "OPEN",
    row: r,
  };
}

export function demoOpenPosition(r: DemoPositionRow): DemoOpenPosition {
  return {
    venue: "DEMO",
    id: r.id,
    // demoOpenCondition always scopes by user id, so a row read here has one.
    userId: r.userId as number,
    ticket: r.brokerPositionId,
    symbol: r.symbol,
    side: r.direction,
    lots: r.lotSize,
    entryPrice: r.entryPrice,
    stopLoss: r.stopLoss,
    takeProfit: r.takeProfit,
    currentPrice: r.currentPrice,
    floatingPnl: r.unrealizedProfitLoss,
    openedAt: r.openedAt,
    recordedAt: r.createdAt,
    observedAt: r.lastSyncedAt,
    sourceCommandId: null,
    bridgeConnectionId: null,
    status: r.status,
    row: r,
  };
}

/**
 * Read one user's open positions. LIVE rows come before DEMO rows for "ALL".
 */
export async function readOpenPositions<V extends OpenPositionVenueSelector>(
  opts: ReadOpenPositionsOptions<V>,
): Promise<Array<ResultFor<V>>> {
  requireUserId(opts.userId);
  const venues = selectedVenues(opts);
  if (opts.tickets !== undefined && opts.tickets.length === 0) return [];
  const out: OpenPosition[] = [];
  for (const venue of venues) {
    if (venue === "LIVE") {
      const rows = await livePositionLedger.read(
        {
          where: liveWhere(opts),
          orderBy: orderFor(opts.order, livePositionColumns),
          limit: opts.limit,
        },
        opts.executor,
      );
      out.push(...rows.map(liveOpenPosition));
    } else {
      const rows = await demoPositionLedger.read(
        {
          where: demoWhere(opts),
          orderBy: orderFor(opts.order, demoPositionColumns),
          limit: opts.limit,
        },
        opts.executor,
      );
      out.push(...rows.map(demoOpenPosition));
    }
  }
  return out as Array<ResultFor<V>>;
}

/** Count one user's open positions with exactly the readOpenPositions predicate. */
export async function countOpenPositions(
  opts: Omit<ReadOpenPositionsOptions, "order" | "limit">,
): Promise<number> {
  requireUserId(opts.userId);
  const venues = selectedVenues(opts);
  if (opts.tickets !== undefined && opts.tickets.length === 0) return 0;
  let total = 0;
  for (const venue of venues) {
    const fields = { c: sql<number>`count(*)::int` };
    const [row] =
      venue === "LIVE"
        ? await livePositionLedger.select(fields, { where: liveWhere(opts) }, opts.executor)
        : await demoPositionLedger.select(fields, { where: demoWhere(opts) }, opts.executor);
    total += Number(row?.c ?? 0);
  }
  return total;
}

// ── Projected reads ─────────────────────────────────────────────────────────
//
// For callers that need a column projection, an aggregate, a caller-chosen
// order or a lock/transaction handle rather than the normalised OpenPosition.
// The read model still owns the "open" predicate (the basis) and the scope
// filters; the caller only chooses columns, grouping and order. Unlike
// readOpenPositions there is NO default order: when `orderBy` is omitted the
// query has no ORDER BY, exactly like the raw ledger reads these replaced.

type ProjectionList = Array<AnyPgColumn | SQL | SQL.Aliased>;

interface OpenPositionProjection {
  orderBy?: ProjectionList;
  groupBy?: ProjectionList;
  limit?: number;
  distinct?: boolean;
  executor?: Reader;
}

export interface SelectLiveOpenPositionsOptions extends OpenPositionProjection {
  /** The one user whose positions are read. Required; never widened. */
  userId: number;
  basis?: LiveOpenPositionBasis;
  symbol?: string;
  /** Restrict to these broker tickets. An empty list matches nothing. */
  tickets?: readonly string[];
  bridgeConnectionId?: number;
}

export interface SelectDemoOpenPositionsOptions extends OpenPositionProjection {
  /** The one user whose positions are read. Required; never widened. */
  userId: number;
  basis?: OpenPositionBasis;
  symbol?: string;
  /** Restrict to these broker position ids. An empty list matches nothing. */
  tickets?: readonly string[];
  /**
   * Only rows the broker has confirmed with a position id
   * (`broker_position_id IS NOT NULL AND broker_position_id <> ''`).
   */
  confirmedTicket?: boolean;
}

function liveSelectWhere(opts: SelectLiveOpenPositionsOptions): SQL {
  const conds: SQL[] = [liveOpenCondition(opts.userId, opts.basis)];
  if (opts.symbol !== undefined) conds.push(eq(livePositionColumns.symbol, opts.symbol));
  // inArray([]) renders `false`, so an empty ticket list matches nothing.
  if (opts.tickets !== undefined) conds.push(inArray(livePositionColumns.brokerTicket, [...opts.tickets]));
  if (opts.bridgeConnectionId !== undefined) {
    conds.push(eq(livePositionColumns.bridgeConnectionId, opts.bridgeConnectionId));
  }
  return and(...conds)!;
}

function demoSelectWhere(opts: SelectDemoOpenPositionsOptions): SQL {
  const conds: SQL[] = [demoOpenCondition(opts.userId, opts.basis)];
  if (opts.symbol !== undefined) conds.push(eq(demoPositionColumns.symbol, opts.symbol));
  if (opts.tickets !== undefined) conds.push(inArray(demoPositionColumns.brokerPositionId, [...opts.tickets]));
  if (opts.confirmedTicket) {
    conds.push(isNotNull(demoPositionColumns.brokerPositionId), ne(demoPositionColumns.brokerPositionId, ""));
  }
  return and(...conds)!;
}

function projection(opts: OpenPositionProjection, where: SQL) {
  return { where, orderBy: opts.orderBy, groupBy: opts.groupBy, limit: opts.limit, distinct: opts.distinct };
}

/**
 * One user's open LIVE positions, projected. Pass `livePositionColumns` for
 * whole rows. Same predicate as readOpenPositions for the same basis.
 */
export async function selectLiveOpenPositions<F extends SelectedFields>(
  fields: F,
  opts: SelectLiveOpenPositionsOptions,
) {
  return livePositionLedger.select(fields, projection(opts, liveSelectWhere(opts)), opts.executor);
}

/**
 * One user's open DEMO positions, projected. Pass `demoPositionColumns` for
 * whole rows. Same predicate as readOpenPositions for the same basis.
 */
export async function selectDemoOpenPositions<F extends SelectedFields>(
  fields: F,
  opts: SelectDemoOpenPositionsOptions,
) {
  return demoPositionLedger.select(fields, projection(opts, demoSelectWhere(opts)), opts.executor);
}

// ── Operator-wide reads ─────────────────────────────────────────────────────
//
// Every user's open rows, for operator views (cockpit, Fund Book, allocation
// governance, reconciliation), platform sweeps (monitor worker, emergency
// close-all) and pool aggregates. They carry the same named bases as the
// per-user reads, so an operator total and a user's own view cannot use
// different meanings of "open". They are deliberately named ...ForAllUsers and
// CI allows only listed modules to import them.

export interface OpenPositionsForAllUsersOptions<B> extends OpenPositionProjection {
  basis?: B;
  /** Restrict to these users. An empty list matches nothing. */
  userIds?: readonly number[];
}

/** The cross-user LIVE predicate for a basis. */
function liveBasisForAllUsers(basis: LiveOpenPositionBasis): SQL {
  if (basis === "UNCLOSED") return isNull(livePositionColumns.closedAt);
  if (basis === "UNCLOSED_RECONCILED") {
    return and(isNull(livePositionColumns.closedAt), isNotNull(livePositionColumns.reconcileState))!;
  }
  return openLiveExposureCondition();
}

/** The cross-user DEMO predicate for a basis. */
function demoBasisForAllUsers(basis: OpenPositionBasis): SQL {
  return basis === "CONFIRMED_OPEN"
    ? eq(demoPositionColumns.status, "OPEN")
    : ne(demoPositionColumns.status, "CLOSED");
}

/** Every user's open LIVE positions, projected. Operator views and sweeps only. */
export async function selectLiveOpenPositionsForAllUsers<F extends SelectedFields>(
  fields: F,
  opts: OpenPositionsForAllUsersOptions<LiveOpenPositionBasis> = {},
) {
  const basis = liveBasisForAllUsers(opts.basis ?? "EXPOSURE");
  const where = opts.userIds !== undefined
    ? and(inArray(livePositionColumns.userId, [...opts.userIds]), basis)!
    : basis;
  return livePositionLedger.select(fields, projection(opts, where), opts.executor);
}

/** Every user's open DEMO positions, projected. Operator views and sweeps only. */
export async function selectDemoOpenPositionsForAllUsers<F extends SelectedFields>(
  fields: F,
  opts: OpenPositionsForAllUsersOptions<OpenPositionBasis> = {},
) {
  const basis = demoBasisForAllUsers(opts.basis ?? "EXPOSURE");
  const where = opts.userIds !== undefined
    ? and(inArray(demoPositionColumns.userId, [...opts.userIds]), basis)!
    : basis;
  return demoPositionLedger.select(fields, projection(opts, where), opts.executor);
}
