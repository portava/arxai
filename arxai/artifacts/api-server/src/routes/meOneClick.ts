// User-facing One-Click Trade settings.
//
// Endpoints:
//
//   GET  /api/me/one-click            — read current settings + computed
//                                       canEnableLive (depends on master-
//                                       live access gate at this moment).
//   PUT  /api/me/one-click            — enable/disable a scope. Body:
//                                         { scope: 'demo'|'live',
//                                           enable: boolean,
//                                           maxLotPerClick?: number }
//                                       Standing consent: flipping a scope ON
//                                       is the user's consent — no typed phrase
//                                       is required. The `REQUIRED_TYPED_PHRASE`
//                                       constant is kept ONLY as the canonical
//                                       consent marker recorded in audit.
//                                       Enabling LIVE additionally requires
//                                       the per-user master-live access
//                                       gate to PASS — toggling on does
//                                       NOT bypass admin approval (403
//                                       LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS
//                                       when BLOCKED).
//   POST /api/me/one-click/submit-live — fast-path submission used by the
//                                       Market Scanner + Live Ticket when
//                                       one-click is ON. Acquires a
//                                       per-user advisory lock, builds
//                                       the live draft, confirms it, and
//                                       dispatches it — every existing
//                                       live gate (16-gate Phase B,
//                                       master-bridge gate, user-access
//                                       gate) still runs end-to-end. The
//                                       toggle only removes the manual UI
//                                       confirmation step; it never
//                                       removes a server gate.
//
// SECURITY: requireUser on every handler. No endpoint reveals another
// user's settings or any bridge/master state.
import express, { type IRouter, Router, type Request, type Response } from "express";
import { requireUser } from "../lib/auth/middleware.js";
import { normalizeProductRole, type ProductRole } from "../lib/auth/productRole.js";
import {
  db, userOneClickSettingsTable, oneClickAuditTable,
  userMasterLiveAccessTable, globalTradingSettingsTable, mt5ConnectionTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { loadAndEvaluateUserMasterLiveAccessGate } from "../lib/mt5/userMasterLiveAccessGate.js";
import { ARX_LOCK_NS, withTxAdvisoryLock } from "../lib/concurrency/advisoryLock.js";
import { tryConsumeToken, checkSymbolCooldown, clampPerMinute } from "../lib/concurrency/rateLimit.js";
import {
  createLiveDraft, confirmLiveCommand, dispatchLiveCommand,
} from "../lib/live/liveCommandPipeline.js";

export const REQUIRED_TYPED_PHRASE = "ENABLE ONE CLICK TRADING";

// Ruby execution-authority model (Task #319). Only AI_ASSISTED executes; AI_AUTO
// is a stored-but-disabled preference (the instant-trade auth layer refuses it).
export const RUBY_AUTHORITY_VALUES = ["OFF", "ADVISE_ONLY", "AI_ASSISTED", "AI_AUTO"] as const;

const router: IRouter = Router();
router.use(express.json());

function userOf(req: Request): number {
  return (req as Request & { authUser?: { id: number } }).authUser!.id;
}

function roleOf(req: Request): ProductRole {
  const raw = (req as Request & { authUser?: { role?: string } }).authUser?.role;
  return normalizeProductRole(raw);
}

async function getOrCreate(userId: number) {
  const existing = await db.select().from(userOneClickSettingsTable)
    .where(eq(userOneClickSettingsTable.userId, userId)).limit(1);
  if (existing[0]) return existing[0];
  const [row] = await db.insert(userOneClickSettingsTable)
    .values({ userId }).returning();
  return row!;
}

async function writeAudit(args: {
  userId: number;
  action: string;
  typedPhrase?: string | null;
  ip?: string | null;
  ua?: string | null;
  metadata?: unknown;
}): Promise<void> {
  await db.insert(oneClickAuditTable).values({
    userId: args.userId,
    action: args.action,
    typedPhrase: args.typedPhrase ?? null,
    ip: args.ip ?? null,
    userAgent: args.ua ?? null,
    metadata: args.metadata != null ? JSON.stringify(args.metadata) : null,
  });
}

router.get("/me/one-click", requireUser, async (req, res) => {
  const userId = userOf(req);
  const row = await getOrCreate(userId);
  const access = await loadAndEvaluateUserMasterLiveAccessGate(userId);
  return res.json({
    ok: true,
    demoOneClickEnabled: row.demoOneClickEnabled,
    liveOneClickEnabled: row.liveOneClickEnabled,
    // Task #353 — armed one-click state surfaced on the main settings payload
    // so Buy/Sell surfaces (LiveTradeTicket, ScannerChartPanel) can activate
    // the fast-trade path without a second API call.
    oneClickArmed: row.oneClickArmed ?? false,
    oneClickArmedAt: row.oneClickArmedAt ?? null,
    oneClickBridgeType: row.oneClickBridgeType ?? null,
    demoEnabledAt: row.demoEnabledAt,
    liveEnabledAt: row.liveEnabledAt,
    maxLotPerClick: row.maxLotPerClick,
    perUserSubmitsPerMinute: row.perUserSubmitsPerMinute,
    defaultSymbol: row.defaultSymbol,
    defaultVolume: row.defaultVolume,
    defaultOrderType: row.defaultOrderType,
    allowOrdersWithoutStopLoss: row.allowOrdersWithoutStopLoss,
    reduceOnlyCloseAllowed: row.reduceOnlyCloseAllowed,
    // Ruby AI command-execution settings (default OFF). When OFF, the
    // instant-trade router refuses any source ∈ {ruby_text, ruby_voice}.
    aiInstantTradeCommandsEnabled: row.aiInstantTradeCommandsEnabled,
    defaultAiTradeSymbol: row.defaultAiTradeSymbol,
    defaultAiTradeVolume: row.defaultAiTradeVolume,
    defaultAiOrderType: row.defaultAiOrderType,
    allowRubyOpenCommands: row.allowRubyOpenCommands,
    allowRubyCloseCommands: row.allowRubyCloseCommands,
    allowRubyModifyCommands: row.allowRubyModifyCommands,
    // Ruby execution-authority model (Task #319). `rubyExecutionAuthority` is
    // the source of truth; AI_ASSISTED is the only mode that executes (skips
    // ONLY the extra prompt, never a backend gate). AI_AUTO is defined but not
    // enabled in this build.
    rubyExecutionAuthority: row.rubyExecutionAuthority,
    rubyRequireExtraConfirmation: row.rubyRequireExtraConfirmation,
    allowRubyBreakEven: row.allowRubyBreakEven,
    allowRubyPartialClose: row.allowRubyPartialClose,
    allowRubyMonitor: row.allowRubyMonitor,
    allowRubyWatchEnter: row.allowRubyWatchEnter,
    allowRubyWatchClose: row.allowRubyWatchClose,
    allowRubyScalpScanner: row.allowRubyScalpScanner,
    maxRubyLotPerTrade: row.maxRubyLotPerTrade,
    maxRubyOpenPositions: row.maxRubyOpenPositions,
    maxRubyDailyTrades: row.maxRubyDailyTrades,
    allowedRubySymbols: row.allowedRubySymbols,
    allowedRubyAssetClasses: row.allowedRubyAssetClasses,
    requiredTypedPhrase: REQUIRED_TYPED_PHRASE,
    canEnableLive: access.decision === "PASS",
    canEnableLiveBlockedReason: access.decision === "BLOCKED" ? access.primaryReason : null,
  });
});

router.put("/me/one-click", requireUser, async (req, res) => {
  const userId = userOf(req);
  const body = (req.body ?? {}) as {
    scope?: "demo" | "live";
    enable?: boolean;
    typedConfirmation?: string;
    maxLotPerClick?: number;
    perUserSubmitsPerMinute?: number;
    defaultSymbol?: string;
    defaultVolume?: number;
    defaultOrderType?: string;
    allowOrdersWithoutStopLoss?: boolean;
    reduceOnlyCloseAllowed?: boolean;
    aiInstantTradeCommandsEnabled?: boolean;
    defaultAiTradeSymbol?: string;
    defaultAiTradeVolume?: number;
    defaultAiOrderType?: string;
    allowRubyOpenCommands?: boolean;
    allowRubyCloseCommands?: boolean;
    allowRubyModifyCommands?: boolean;
    rubyExecutionAuthority?: string;
    rubyRequireExtraConfirmation?: boolean;
    allowRubyBreakEven?: boolean;
    allowRubyPartialClose?: boolean;
    allowRubyMonitor?: boolean;
    allowRubyWatchEnter?: boolean;
    allowRubyWatchClose?: boolean;
    allowRubyScalpScanner?: boolean;
    maxRubyLotPerTrade?: number | null;
    maxRubyOpenPositions?: number | null;
    maxRubyDailyTrades?: number | null;
    allowedRubySymbols?: string[] | null;
    allowedRubyAssetClasses?: string[] | null;
  };
  // `scope`/`enable` drive the one-click demo/live toggle. They are OPTIONAL:
  // when both are present we run the toggle (with its typed-confirmation +
  // master-live gates); when absent the request only updates the standalone
  // Ruby authority/permission/cap fields below. If a caller sends one without
  // the other we reject — a half-specified toggle is a client bug.
  const togglingScope = body.scope === "demo" || body.scope === "live";
  if (togglingScope && typeof body.enable !== "boolean") {
    return res.status(400).json({ ok: false, error: "INVALID_ENABLE" });
  }
  if (!togglingScope && body.scope !== undefined) {
    return res.status(400).json({ ok: false, error: "INVALID_SCOPE" });
  }
  if (!togglingScope && typeof body.enable === "boolean") {
    return res.status(400).json({ ok: false, error: "SCOPE_REQUIRED_FOR_ENABLE" });
  }
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? null;
  const ua = (req.headers["user-agent"] as string | undefined) ?? null;

  // Standing-consent model (Task #745): flipping the one-click toggle ON is
  // itself the user's explicit, standing consent — no typed phrase is
  // required. The LIVE scope STILL requires the per-user master-live access
  // gate to PASS; the toggle never bypasses admin approval. The persisted
  // warning copy on every toggle surface remains the user-facing disclosure.
  if (body.enable === true && body.scope === "live") {
    const access = await loadAndEvaluateUserMasterLiveAccessGate(userId);
    if (access.decision === "BLOCKED") {
      return res.status(403).json({
        ok: false,
        error: "LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS",
        blockReason: access.primaryReason,
        message: "Admin approval required before live one-click can be enabled.",
      });
    }
  }
  await getOrCreate(userId);
  const update: Partial<typeof userOneClickSettingsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.scope === "demo") {
    update.demoOneClickEnabled = body.enable;
    if (body.enable) {
      update.demoEnabledAt = new Date();
      // Standing-consent marker: the toggle gesture IS consent (no typed
      // phrase). Record the canonical consent phrase for audit replay.
      update.demoTypedConfirmation = REQUIRED_TYPED_PHRASE;
    } else {
      update.demoDisabledAt = new Date();
    }
  } else if (body.scope === "live") {
    update.liveOneClickEnabled = body.enable;
    if (body.enable) {
      update.liveEnabledAt = new Date();
      // Standing-consent marker (see demo scope above).
      update.liveTypedConfirmation = REQUIRED_TYPED_PHRASE;
    } else {
      update.liveDisabledAt = new Date();
    }
  }
  if (typeof body.maxLotPerClick === "number") update.maxLotPerClick = body.maxLotPerClick;
  if (typeof body.perUserSubmitsPerMinute === "number") {
    update.perUserSubmitsPerMinute = clampPerMinute(body.perUserSubmitsPerMinute);
  }
  // Fast-trade UX preferences. These are NOT safety toggles —
  // per-market max lot + symbol allowlist + 16-gate evaluator still run
  // regardless of what's saved here.
  if (typeof body.defaultSymbol === "string" && body.defaultSymbol.trim().length > 0) {
    update.defaultSymbol = body.defaultSymbol.trim().toUpperCase().slice(0, 16);
  }
  if (typeof body.defaultVolume === "number" && body.defaultVolume > 0) {
    update.defaultVolume = body.defaultVolume;
  }
  if (typeof body.defaultOrderType === "string" && body.defaultOrderType.length > 0) {
    update.defaultOrderType = body.defaultOrderType.slice(0, 32);
  }
  if (typeof body.allowOrdersWithoutStopLoss === "boolean") {
    update.allowOrdersWithoutStopLoss = body.allowOrdersWithoutStopLoss;
  }
  if (typeof body.reduceOnlyCloseAllowed === "boolean") {
    update.reduceOnlyCloseAllowed = body.reduceOnlyCloseAllowed;
  }
  // Ruby AI command-execution settings. Flipping
  // aiInstantTradeCommandsEnabled to true is the master switch that allows
  // Ruby to call /api/trades/instant/*; the three allow* flags scope WHICH
  // actions Ruby may perform. Default ON for close/modify, OFF for open.
  let aiToggleAuditAction: "AI_INSTANT_TRADE_ENABLED" | "AI_INSTANT_TRADE_DISABLED" | null = null;
  if (typeof body.aiInstantTradeCommandsEnabled === "boolean") {
    if (body.aiInstantTradeCommandsEnabled === true && body.scope === "live") {
      // Enabling Ruby trading requires the user to ALSO be approved for
      // live (master-live access PASS) — defence in depth.
      const access = await loadAndEvaluateUserMasterLiveAccessGate(userId);
      if (access.decision === "BLOCKED") {
        return res.status(403).json({
          ok: false,
          error: "RUBY_TRADING_REQUIRES_MASTER_LIVE_ACCESS",
          blockReason: access.primaryReason,
        });
      }
    }
    update.aiInstantTradeCommandsEnabled = body.aiInstantTradeCommandsEnabled;
    aiToggleAuditAction = body.aiInstantTradeCommandsEnabled
      ? "AI_INSTANT_TRADE_ENABLED" : "AI_INSTANT_TRADE_DISABLED";
  }
  if (typeof body.defaultAiTradeSymbol === "string" && body.defaultAiTradeSymbol.trim().length > 0) {
    update.defaultAiTradeSymbol = body.defaultAiTradeSymbol.trim().toUpperCase().slice(0, 16);
  }
  if (typeof body.defaultAiTradeVolume === "number" && body.defaultAiTradeVolume > 0) {
    update.defaultAiTradeVolume = body.defaultAiTradeVolume;
  }
  if (typeof body.defaultAiOrderType === "string" && body.defaultAiOrderType.length > 0) {
    update.defaultAiOrderType = body.defaultAiOrderType.slice(0, 32);
  }
  if (typeof body.allowRubyOpenCommands === "boolean") update.allowRubyOpenCommands = body.allowRubyOpenCommands;
  if (typeof body.allowRubyCloseCommands === "boolean") update.allowRubyCloseCommands = body.allowRubyCloseCommands;
  if (typeof body.allowRubyModifyCommands === "boolean") update.allowRubyModifyCommands = body.allowRubyModifyCommands;

  // ── Ruby execution-authority model (Task #319) ───────────────────────────
  // `rubyExecutionAuthority` is the SOURCE OF TRUTH. Only AI_ASSISTED executes.
  // AI_AUTO is accepted as a stored preference but is NOT enabled in this build
  // (the instant-trade auth layer refuses execution under AI_AUTO). Setting
  // AI_ASSISTED requires master-live access (defence in depth) just like the
  // legacy aiInstantTradeCommandsEnabled master switch.
  let newAuthority: string | null = null;
  if (typeof body.rubyExecutionAuthority === "string") {
    const authority = body.rubyExecutionAuthority.trim().toUpperCase();
    if (!RUBY_AUTHORITY_VALUES.includes(authority as (typeof RUBY_AUTHORITY_VALUES)[number])) {
      return res.status(400).json({ ok: false, error: "INVALID_RUBY_AUTHORITY" });
    }
    if (authority === "AI_ASSISTED") {
      const access = await loadAndEvaluateUserMasterLiveAccessGate(userId);
      if (access.decision === "BLOCKED") {
        return res.status(403).json({
          ok: false,
          error: "RUBY_TRADING_REQUIRES_MASTER_LIVE_ACCESS",
          blockReason: access.primaryReason,
        });
      }
    }
    update.rubyExecutionAuthority = authority;
    // Keep the legacy boolean in lockstep so older readers stay consistent:
    // enabled iff the authority is the only executing mode.
    update.aiInstantTradeCommandsEnabled = authority === "AI_ASSISTED";
    newAuthority = authority;
  }
  if (typeof body.rubyRequireExtraConfirmation === "boolean") {
    update.rubyRequireExtraConfirmation = body.rubyRequireExtraConfirmation;
  }
  if (typeof body.allowRubyBreakEven === "boolean") update.allowRubyBreakEven = body.allowRubyBreakEven;
  if (typeof body.allowRubyPartialClose === "boolean") update.allowRubyPartialClose = body.allowRubyPartialClose;
  if (typeof body.allowRubyMonitor === "boolean") update.allowRubyMonitor = body.allowRubyMonitor;
  if (typeof body.allowRubyWatchEnter === "boolean") update.allowRubyWatchEnter = body.allowRubyWatchEnter;
  if (typeof body.allowRubyWatchClose === "boolean") update.allowRubyWatchClose = body.allowRubyWatchClose;
  if (typeof body.allowRubyScalpScanner === "boolean") update.allowRubyScalpScanner = body.allowRubyScalpScanner;

  // Caps. `null` clears the cap (account limits still apply); a positive number
  // sets a stricter Ruby-only ceiling. Negative/zero/NaN are rejected.
  if (body.maxRubyLotPerTrade !== undefined) {
    if (body.maxRubyLotPerTrade === null) update.maxRubyLotPerTrade = null;
    else if (typeof body.maxRubyLotPerTrade === "number" && body.maxRubyLotPerTrade > 0) {
      update.maxRubyLotPerTrade = body.maxRubyLotPerTrade;
    } else return res.status(400).json({ ok: false, error: "INVALID_MAX_RUBY_LOT" });
  }
  if (body.maxRubyOpenPositions !== undefined) {
    if (body.maxRubyOpenPositions === null) update.maxRubyOpenPositions = null;
    else if (Number.isInteger(body.maxRubyOpenPositions) && body.maxRubyOpenPositions > 0) {
      update.maxRubyOpenPositions = body.maxRubyOpenPositions;
    } else return res.status(400).json({ ok: false, error: "INVALID_MAX_RUBY_OPEN_POSITIONS" });
  }
  if (body.maxRubyDailyTrades !== undefined) {
    if (body.maxRubyDailyTrades === null) update.maxRubyDailyTrades = null;
    else if (Number.isInteger(body.maxRubyDailyTrades) && body.maxRubyDailyTrades > 0) {
      update.maxRubyDailyTrades = body.maxRubyDailyTrades;
    } else return res.status(400).json({ ok: false, error: "INVALID_MAX_RUBY_DAILY_TRADES" });
  }
  // Allowlists. `null` or [] = inherit account allowlist / all asset classes.
  if (body.allowedRubySymbols !== undefined) {
    update.allowedRubySymbols = Array.isArray(body.allowedRubySymbols) && body.allowedRubySymbols.length > 0
      ? JSON.stringify(body.allowedRubySymbols
          .filter((s) => typeof s === "string" && s.trim().length > 0)
          .map((s) => s.trim().toUpperCase().slice(0, 32)))
      : null;
  }
  if (body.allowedRubyAssetClasses !== undefined) {
    update.allowedRubyAssetClasses = Array.isArray(body.allowedRubyAssetClasses) && body.allowedRubyAssetClasses.length > 0
      ? JSON.stringify(body.allowedRubyAssetClasses
          .filter((s) => typeof s === "string" && s.trim().length > 0)
          .map((s) => s.trim().toLowerCase().slice(0, 32)))
      : null;
  }

  const [updated] = await db.update(userOneClickSettingsTable).set(update)
    .where(eq(userOneClickSettingsTable.userId, userId)).returning();
  if (togglingScope) {
    await writeAudit({
      userId,
      action: `${body.enable ? "ENABLE" : "DISABLE"}_${body.scope === "demo" ? "DEMO" : "LIVE"}`,
      typedPhrase: body.enable ? REQUIRED_TYPED_PHRASE : null,
      ip, ua,
      metadata: { maxLotPerClick: body.maxLotPerClick ?? null },
    });
  }
  if (aiToggleAuditAction) {
    await writeAudit({
      userId, action: aiToggleAuditAction, ip, ua,
      metadata: {
        allowRubyOpenCommands: body.allowRubyOpenCommands ?? null,
        allowRubyCloseCommands: body.allowRubyCloseCommands ?? null,
        allowRubyModifyCommands: body.allowRubyModifyCommands ?? null,
      },
    });
  }
  if (newAuthority) {
    await writeAudit({
      userId, action: "RUBY_AUTHORITY_UPDATED", ip, ua,
      metadata: {
        rubyExecutionAuthority: newAuthority,
        rubyRequireExtraConfirmation: update.rubyRequireExtraConfirmation ?? null,
        maxRubyLotPerTrade: update.maxRubyLotPerTrade ?? null,
        maxRubyOpenPositions: update.maxRubyOpenPositions ?? null,
        maxRubyDailyTrades: update.maxRubyDailyTrades ?? null,
      },
    });
  }
  return res.json({ ok: true, settings: updated });
});

/**
 * POST /api/me/one-click/submit-live — fast-path live submit.
 *
 * Body: same shape as createLiveDraft input. The endpoint:
 *
 *  1. Verifies user.liveOneClickEnabled = true (else 412).
 *  2. Re-runs the master-live access gate (defense in depth).
 *  3. Takes a per-user advisory lock to serialize double-tap submits.
 *  4. Token-bucket rate limit (per user) + per-symbol cooldown.
 *  5. Calls createLiveDraft + confirmLiveCommand + dispatchLiveCommand.
 *     dispatchLiveCommand still runs every Phase B gate, the user-access
 *     gate, the master-bridge gate, and the atomic exposure reservation.
 *
 * Toggle ON is NOT a bypass of any server gate.
 */
router.post("/me/one-click/submit-live", requireUser, async (req: Request, res: Response) => {
  const userId = userOf(req);
  const settings = await getOrCreate(userId);
  // Honor EITHER the legacy toggle OR the Task #353 armed flag — same OR semantics
  // as instantTrade.ts. Both paths go through the same 16-gate Phase B evaluator.
  if (!settings.liveOneClickEnabled && !settings.oneClickArmed) {
    return res.status(412).json({ ok: false, error: "LIVE_ONE_CLICK_DISABLED" });
  }
  const access = await loadAndEvaluateUserMasterLiveAccessGate(userId);
  if (access.decision === "BLOCKED") {
    return res.status(403).json({
      ok: false, error: "MASTER_LIVE_USER_ACCESS_BLOCKED",
      blockReason: access.primaryReason,
    });
  }
  const body = (req.body ?? {}) as {
    symbol?: string; side?: "BUY" | "SELL"; orderType?: string;
    commandType?: "PLACE_LIVE_MARKET_ORDER" | "PLACE_LIVE_PENDING_ORDER";
    requestedVolume?: number; stopLoss?: number | null; takeProfit?: number | null;
    sourcePage?: string; rubyExplanationSummary?: string | null;
    payload?: Record<string, unknown>;
  };
  if (!body.symbol || (body.side !== "BUY" && body.side !== "SELL") || typeof body.requestedVolume !== "number") {
    return res.status(400).json({ ok: false, error: "INVALID_TICKET" });
  }
  // Resolve commandType. Prefer explicit body.commandType; otherwise classify
  // from orderType. Frontend sends `MARKET_BUY`/`MARKET_SELL` for market and
  // names like `LIMIT_BUY`, `STOP_SELL` for pending.
  const orderTypeStr = body.orderType ?? "MARKET";
  const isMarketOrder =
    body.commandType === "PLACE_LIVE_MARKET_ORDER"
    || (!body.commandType && /MARKET/i.test(orderTypeStr));
  const resolvedCommandType: "PLACE_LIVE_MARKET_ORDER" | "PLACE_LIVE_PENDING_ORDER" =
    isMarketOrder ? "PLACE_LIVE_MARKET_ORDER" : "PLACE_LIVE_PENDING_ORDER";
  // Per-symbol cooldown — prevents instant double-fire on same symbol.
  if (!checkSymbolCooldown(body.symbol, userId)) {
    return res.status(429).json({ ok: false, error: "SYMBOL_COOLDOWN" });
  }
  // Per-user token bucket.
  if (!tryConsumeToken(`user:${userId}`, settings.perUserSubmitsPerMinute)) {
    return res.status(429).json({ ok: false, error: "USER_SUBMIT_RATE_LIMITED" });
  }

  // One-click no-SL override: takes effect ONLY when the user has
  // explicitly opted in via PUT /me/one-click {allowOrdersWithoutStopLoss:true}
  // AND submitted a draft without a stop-loss. Approval + typed-phrase +
  // master-live + per-market max-lot + 16-gate evaluator still all run.
  const noSlOverride = settings.allowOrdersWithoutStopLoss === true
    && (body.stopLoss == null || body.stopLoss <= 0);

  // Per-user advisory lock — blocks double-tap from the same user.
  const lock = await withTxAdvisoryLock(ARX_LOCK_NS.USER_SUBMIT, userId, async () => {
    const draft = await createLiveDraft({
      userId,
      commandType: resolvedCommandType,
      symbol: body.symbol!,
      side: body.side!,
      orderType: orderTypeStr,
      requestedVolume: body.requestedVolume!,
      stopLoss: body.stopLoss ?? null,
      takeProfit: body.takeProfit ?? null,
      sourcePage: body.sourcePage ?? "ONE_CLICK",
      rubyExplanationSummary: body.rubyExplanationSummary ?? null,
      payload: body.payload ?? {},
      allowNoStopLossThisDraft: noSlOverride,
    });
    if (!("ok" in draft) || draft.ok !== true) return { stage: "draft" as const, result: draft };
    const confirmed = await confirmLiveCommand({ userId, commandId: draft.command.commandId });
    if (!confirmed.ok) return { stage: "confirm" as const, result: confirmed };
    const dispatched = await dispatchLiveCommand({ userId, commandId: draft.command.commandId });
    return { stage: "dispatch" as const, result: dispatched, commandId: draft.command.commandId };
  });
  if (!lock.acquired) {
    return res.status(409).json({ ok: false, error: "USER_SUBMIT_LOCKED" });
  }
  const stageOut = lock.value;
  await writeAudit({
    userId, action: "SUBMIT_LIVE_ONE_CLICK",
    metadata: {
      stage: stageOut.stage,
      symbol: body.symbol,
      side: body.side,
      volume: body.requestedVolume,
      stopLoss: body.stopLoss ?? null,
      takeProfit: body.takeProfit ?? null,
      orderType: orderTypeStr,
      commandType: resolvedCommandType,
      noSlOverrideApplied: noSlOverride,
      oneClickLiveTradingEnabled: settings.liveOneClickEnabled,
    },
  });
  if (stageOut.stage === "dispatch") {
    const r = stageOut.result;
    return res.json({ ...r, ok: r.ok === true, commandId: stageOut.commandId });
  }
  return res.status(409).json({ ...stageOut.result, ok: false, stage: stageOut.stage });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task #353 — Bridge-type-aware armed one-click trading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve whether this user is on a SHARED or OWN bridge.
 *
 *   OWN    — user has their own mt5_connection row
 *   SHARED — global routing mode is SHARED_MASTER_MT5 and user has no own bridge
 *   NONE   — no bridge configured for this user
 */
async function resolveBridgeType(userId: number): Promise<"SHARED" | "OWN" | "NONE"> {
  const [conn] = await db.select({ id: mt5ConnectionTable.id })
    .from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.userId, userId))
    .limit(1);
  if (conn) return "OWN";
  const [g] = await db.select({ mode: globalTradingSettingsTable.accountRoutingMode })
    .from(globalTradingSettingsTable)
    .limit(1);
  return g?.mode === "SHARED_MASTER_MT5" ? "SHARED" : "NONE";
}

/**
 * Check whether this user can arm one-click, and why not if blocked.
 *
 * Role gate (applied first, all bridge types):
 *   INVESTOR accounts are view-only and may never arm one-click.
 *
 * OWN-bridge: requires master-live access gate PASS (bridge live/ready).
 * SHARED-bridge: requires sharedBridgeOneClickPermitted = true on master live access row.
 */
async function canArmCheck(
  userId: number,
  bridgeType: "SHARED" | "OWN" | "NONE",
  settings: Awaited<ReturnType<typeof getOrCreate>>,
  userRole: ProductRole,
): Promise<{ canArm: boolean; blockReason: string | null; sharedPermitted: boolean }> {
  // Investor/view-only accounts may never arm one-click trading.
  if (userRole === "INVESTOR") {
    return { canArm: false, blockReason: "INVESTOR_ROLE_CANNOT_ARM", sharedPermitted: false };
  }
  if (bridgeType === "NONE") {
    return { canArm: false, blockReason: "NO_BRIDGE_CONFIGURED", sharedPermitted: false };
  }
  if (bridgeType === "SHARED") {
    const [access] = await db.select({
      permitted: userMasterLiveAccessTable.sharedBridgeOneClickPermitted,
    }).from(userMasterLiveAccessTable)
      .where(eq(userMasterLiveAccessTable.userId, userId)).limit(1);
    const permitted = access?.permitted ?? false;
    if (!permitted) {
      return { canArm: false, blockReason: "SHARED_BRIDGE_ONE_CLICK_NOT_PERMITTED", sharedPermitted: false };
    }
    // Require a default symbol — without it the fast-trade path has no target instrument.
    if (!settings.defaultSymbol || settings.defaultSymbol.trim() === "") {
      return { canArm: false, blockReason: "DEFAULT_SYMBOL_NOT_SET", sharedPermitted: true };
    }
    // Require a default lot size — without it the fast-trade path has no volume.
    if (!settings.defaultVolume || settings.defaultVolume <= 0) {
      return { canArm: false, blockReason: "DEFAULT_VOLUME_NOT_SET", sharedPermitted: true };
    }
    return { canArm: true, blockReason: null, sharedPermitted: true };
  }
  // OWN bridge: require master-live access gate PASS
  const gate = await loadAndEvaluateUserMasterLiveAccessGate(userId);
  if (gate.decision === "BLOCKED") {
    return { canArm: false, blockReason: gate.primaryReason ?? "MASTER_LIVE_USER_ACCESS_BLOCKED", sharedPermitted: false };
  }
  // Require a default symbol — without it the fast-trade path has no target instrument.
  if (!settings.defaultSymbol || settings.defaultSymbol.trim() === "") {
    return { canArm: false, blockReason: "DEFAULT_SYMBOL_NOT_SET", sharedPermitted: false };
  }
  // Require default lot > 0
  if (!settings.defaultVolume || settings.defaultVolume <= 0) {
    return { canArm: false, blockReason: "DEFAULT_VOLUME_NOT_SET", sharedPermitted: false };
  }
  return { canArm: true, blockReason: null, sharedPermitted: false };
}

/**
 * GET /api/me/one-click/status — bridge-type-aware armed one-click status.
 *
 * Returns:
 *   bridgeType: "SHARED" | "OWN" | "NONE"
 *   armed: boolean
 *   armedAt: ISO string | null
 *   canArm: boolean
 *   canArmBlockReason: string | null
 *   sharedBridgePermissionGranted: boolean
 *   defaultSymbol, defaultVolume, maxLotPerClick
 */
router.get("/me/one-click/status", requireUser, async (req: Request, res: Response) => {
  const userId = userOf(req);
  const userRole = roleOf(req);
  const settings = await getOrCreate(userId);
  const bridgeType = await resolveBridgeType(userId);
  const { canArm, blockReason, sharedPermitted } = await canArmCheck(userId, bridgeType, settings, userRole);

  // Execution readiness — indicates whether a one-click dispatch would be
  // accepted at the armed-one-click layer right now. This is NOT the full
  // 16-gate check; it reflects the pre-dispatch coherence state only.
  // The 16-gate evaluator always runs server-side on every actual dispatch.
  let executionReadinessState: "READY" | "BLOCKED" | "STALE" | "UNAVAILABLE";
  let executionBlockReason: string | null = null;
  const HEARTBEAT_STALE_MS = 15_000; // mirrors Phase B gate #7
  if (bridgeType === "NONE") {
    executionReadinessState = "UNAVAILABLE";
    executionBlockReason = "NO_BRIDGE_CONFIGURED";
  } else if (!settings.oneClickArmed) {
    executionReadinessState = "BLOCKED";
    executionBlockReason = "NOT_ARMED";
  } else if (
    settings.oneClickBridgeType &&
    settings.oneClickBridgeType !== bridgeType
  ) {
    executionReadinessState = "STALE";
    executionBlockReason = "BRIDGE_TYPE_CHANGED_SINCE_ARM";
  } else if (bridgeType === "SHARED" && !sharedPermitted) {
    executionReadinessState = "BLOCKED";
    executionBlockReason = "SHARED_BRIDGE_PERMISSION_REVOKED";
  } else if (bridgeType === "OWN") {
    // For own-bridge users, check whether their bridge heartbeat is fresh.
    // A stale/absent heartbeat means the EA is disconnected; dispatching
    // live commands will fail gate #7 on the 16-gate evaluator.
    const [conn] = await db.select({
      lastHeartbeat: mt5ConnectionTable.lastHeartbeat,
    }).from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.userId, userId))
      .limit(1);
    const heartbeatMs = conn?.lastHeartbeat ? conn.lastHeartbeat.getTime() : null;
    const ageMs = heartbeatMs !== null ? Date.now() - heartbeatMs : Infinity;
    if (ageMs > HEARTBEAT_STALE_MS) {
      executionReadinessState = "STALE";
      executionBlockReason = "OWN_BRIDGE_STALE_OR_DISCONNECTED";
    } else {
      executionReadinessState = "READY";
    }
  } else {
    executionReadinessState = "READY";
  }
  const executionReady = executionReadinessState === "READY";

  return res.json({
    ok: true,
    bridgeType,
    armed: settings.oneClickArmed,
    armedAt: settings.oneClickArmedAt ?? null,
    disarmedAt: settings.oneClickDisarmedAt ?? null,
    canArm,
    canArmBlockReason: blockReason,
    sharedBridgePermissionGranted: sharedPermitted,
    defaultSymbol: settings.defaultSymbol,
    defaultVolume: settings.defaultVolume,
    maxLotPerClick: settings.maxLotPerClick ?? null,
    executionReady,
    executionReadinessState,
    executionBlockReason,
  });
});

/**
 * POST /api/me/one-click/arm — arm one-click trading.
 *
 * Body: { agreed: true }  — user must send explicit agreement flag.
 *
 * Rules:
 *   - Fails if bridge type is NONE (no bridge configured).
 *   - Shared-bridge: requires sharedBridgeOneClickPermitted = true.
 *   - Own-bridge: requires master-live access gate PASS + defaultVolume > 0.
 *   - All 16 Phase B gates still run on every dispatch — arm only removes
 *     the manual UI confirmation step.
 */
router.post("/me/one-click/arm", requireUser, async (req: Request, res: Response) => {
  const userId = userOf(req);
  const userRole = roleOf(req);
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? null;
  const ua = (req.headers["user-agent"] as string | undefined) ?? null;
  const body = (req.body ?? {}) as { agreed?: boolean };
  if (body.agreed !== true) {
    return res.status(400).json({ ok: false, error: "AGREEMENT_REQUIRED",
      message: "Send { agreed: true } to confirm you understand the risks." });
  }
  const settings = await getOrCreate(userId);
  const bridgeType = await resolveBridgeType(userId);
  const { canArm, blockReason } = await canArmCheck(userId, bridgeType, settings, userRole);
  if (!canArm) {
    return res.status(403).json({ ok: false, error: "ONE_CLICK_ARM_BLOCKED", blockReason });
  }
  const now = new Date();
  await db.update(userOneClickSettingsTable).set({
    oneClickArmed: true,
    oneClickArmedAt: now,
    oneClickDisarmedAt: null,
    oneClickBridgeType: bridgeType,
    updatedAt: now,
  }).where(eq(userOneClickSettingsTable.userId, userId));
  await writeAudit({
    userId, action: "ONE_CLICK_ARMED", ip, ua,
    metadata: { bridgeType, defaultVolume: settings.defaultVolume },
  });
  return res.json({
    ok: true,
    armed: true,
    armedAt: now.toISOString(),
    bridgeType,
  });
});

/**
 * POST /api/me/one-click/disarm — disarm one-click trading.
 *
 * No body required. Always succeeds (idempotent).
 */
router.post("/me/one-click/disarm", requireUser, async (req: Request, res: Response) => {
  const userId = userOf(req);
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? null;
  const ua = (req.headers["user-agent"] as string | undefined) ?? null;
  const settings = await getOrCreate(userId);
  const now = new Date();
  await db.update(userOneClickSettingsTable).set({
    oneClickArmed: false,
    oneClickDisarmedAt: now,
    updatedAt: now,
  }).where(eq(userOneClickSettingsTable.userId, userId));
  await writeAudit({
    userId, action: "ONE_CLICK_DISARMED", ip, ua,
    metadata: { wasArmed: settings.oneClickArmed, bridgeType: settings.oneClickBridgeType },
  });
  return res.json({ ok: true, armed: false, disarmedAt: now.toISOString() });
});

export default router;
