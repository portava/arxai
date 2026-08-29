// instantTrade.ts — shared helper used by:
//   - POST /api/trades/instant/{execute,close,close-all,validate}
//   - POST /api/me/assistant/instant-trade-command (Ruby text/voice)
//   - any future trade-capable widget
//
// SAFETY: this is a thin orchestrator. Every actual safety decision
// remains in the existing pipeline:
//   - createLiveDraft → preflight (master-live access, kill switch,
//     server master switch, EA freshness, missing SL unless override)
//   - confirmLiveCommand
//   - dispatchLiveCommand → 16-gate evaluator + atomic exposure
//     reservation + bridge dispatch
//
// What this helper adds is SOURCE-AWARENESS:
//   - When `intent.source ∈ {ruby_text, ruby_voice}` it also requires
//     `aiInstantTradeCommandsEnabled = true` AND the action-appropriate
//     allowRuby* flag. This is a per-user Ruby authorization layer that
//     sits on TOP of every other live gate, never replacing them.
//
// `accountMode: "demo"` is recognized for API symmetry but the helper
// returns `UNSUPPORTED_ACCOUNT_MODE_FOR_INSTANT_LIVE` — demo continues
// to flow through its existing endpoint (`/api/mt5/demo-*`). That keeps
// the live blast radius minimal and the demo path byte-for-byte
// unchanged. Phase 5: `"paper"` was removed from the production mode
// union; the route layer rejects `accountMode=paper` with the canonical
// "Paper Trading has been removed" 400 before this helper runs.
import { db, userOneClickSettingsTable, oneClickAuditTable, arxLivePositionsTable, rubyCommandsTable } from "@workspace/db";
import { and, eq, isNull, gte, inArray } from "drizzle-orm";
import { getSymbolProfile } from "../data/chart/symbolProfile.js";
import { loadAndEvaluateUserMasterLiveAccessGate } from "../mt5/userMasterLiveAccessGate.js";
import { ARX_LOCK_NS, withTxAdvisoryLock } from "../concurrency/advisoryLock.js";
import { tryConsumeToken, checkSymbolCooldown } from "../concurrency/rateLimit.js";
import {
  createLiveDraft, confirmLiveCommand, dispatchLiveCommand,
  createLiveOpsDraft,
} from "./liveCommandPipeline.js";
import { liveBrokerExecutionEnabled } from "./phaseBConfig.js";
import { resolveBrokerSymbol } from "../mt5/symbolDirectory.js";
import { recordManualAaciAdvisory } from "../aaci/manualAdvisory.js";
import type { CommandProvenanceEnvelope } from "../provenance/commandProvenance.js";
import { enforceSensitiveAction } from "../security/handshake.js";

export const INSTANT_TRADE_SOURCES = [
  "trade_panel", "scanner", "chart", "chart_drag", "watchlist", "position_card",
  "dashboard", "alert", "ruby_text", "ruby_voice", "self_trade", "mission",
] as const;
export type InstantTradeSource = (typeof INSTANT_TRADE_SOURCES)[number];

export const INSTANT_TRADE_ACTIONS = [
  "BUY", "SELL", "CLOSE", "CLOSE_ALL", "MODIFY_SL_TP",
] as const;
export type InstantTradeAction = (typeof INSTANT_TRADE_ACTIONS)[number];

export type InstantTradeIntent = {
  source: InstantTradeSource;
  action: InstantTradeAction;
  accountMode: "live" | "demo";
  symbol?: string;
  volume?: number;
  orderType?: string;
  stopLoss?: number | null;
  takeProfit?: number | null;
  positionId?: string;
  newStopLoss?: number | null;
  newTakeProfit?: number | null;
  oneClick?: boolean;
  aiCommand?: boolean;
  rawUserCommand?: string | null;
  parsedByRuby?: boolean;
  // Task #213 — Self-Trade AI autonomous execution ownership tags (additive,
  // optional). When set, the OPEN draft is attributed to the originating agent
  // + supervisor-approved decision, and `prepareOnly` (autonomy L1) stops the
  // flow AFTER createLiveDraft succeeds — never confirming or dispatching. No
  // behavior change for any non-agent caller (all fields absent).
  selfTradeAgentId?: number | null;
  selfTradeDecisionId?: number | null;
  selfTradeAgentKey?: string | null;
  prepareOnly?: boolean;
  // Task #319 — Ruby bounded executor. `rubyCommandKind` lets the auth layer
  // distinguish a plain MODIFY from a break-even move, and a full CLOSE from a
  // PARTIAL_CLOSE, so the per-action permission flags map correctly. Optional;
  // absent for every non-Ruby caller. `closeVolume`, when set on a CLOSE,
  // reduces only that many lots (the existing CLOSE_LIVE_POSITION draft already
  // takes a volume — this is the SAME primitive, not a new path).
  rubyCommandKind?: string | null;
  closeVolume?: number | null;
  // Task #804 — Profit Mission ownership tag (additive, optional). When a mission
  // dispatches or manages a trade it sets `source: "mission"` and stamps the
  // originating `missionId` here so the router's oneClickAudit metadata (which
  // logs the whole intent) durably attributes the command to its mission. Same
  // additive-tag precedent as `selfTradeAgentId` (#213): zero behavior change for
  // any non-mission caller (absent), and it NEVER relaxes a gate — the 18-gate
  // dispatch is unchanged. The durable DB linkage remains the mission_trade_drafts
  // row (which carries missionId) + the journaled commandId.
  missionId?: number | null;
  // Foundation gates #19/#20 producer seams (additive, optional). `provenance`
  // is a pre-built command provenance envelope (see
  // lib/provenance/commandProvenance.ts — the exposed helper any producer can
  // adopt); absent, createLiveDraft derives one honestly from the routed quote
  // at draft time. `edgeId` links the command to its production_edges row so
  // gate #20 can read promotion state at dispatch; absent for human clicks
  // (not required) and REFUSED at dispatch for autonomous entries (default-
  // deny). Neither field can ever relax a gate.
  provenance?: CommandProvenanceEnvelope | null;
  edgeId?: number | null;
};

// Reasons surfaced by the Ruby authorization layer. Each is AND-gated on TOP of
// every other live gate; none can ever relax the 16-gate dispatch.
export const RUBY_AUTH_REASONS = [
  "RUBY_TRADING_NOT_ENABLED",
  "RUBY_ADVISE_ONLY_MODE",
  "RUBY_AI_AUTO_NOT_ENABLED",
  "RUBY_OPEN_COMMANDS_NOT_ENABLED",
  "RUBY_CLOSE_COMMANDS_NOT_ENABLED",
  "RUBY_PARTIAL_CLOSE_NOT_ENABLED",
  "RUBY_MODIFY_COMMANDS_NOT_ENABLED",
  "RUBY_BREAK_EVEN_NOT_ENABLED",
  "RUBY_LOT_CAP_EXCEEDED",
  "RUBY_SYMBOL_NOT_ALLOWED",
  "RUBY_ASSET_CLASS_NOT_ALLOWED",
  "RUBY_MAX_OPEN_POSITIONS_REACHED",
  "RUBY_DAILY_TRADE_LIMIT_REACHED",
] as const;
export type RubyAuthReason = (typeof RUBY_AUTH_REASONS)[number];

export type InstantTradeResult =
  | { ok: true; commandId?: string; action: InstantTradeAction; detail?: unknown }
  | { ok: false; error: string; primaryReason?: string; blockingReasonCode?: string; detail?: unknown; httpStatus: number };

async function writeAudit(args: {
  userId: number; action: string; ip?: string | null; ua?: string | null; metadata?: unknown;
}): Promise<void> {
  await db.insert(oneClickAuditTable).values({
    userId: args.userId, action: args.action,
    ip: args.ip ?? null, userAgent: args.ua ?? null,
    metadata: args.metadata != null ? JSON.stringify(args.metadata) : null,
  });
}

async function getSettings(userId: number) {
  const rows = await db.select().from(userOneClickSettingsTable)
    .where(eq(userOneClickSettingsTable.userId, userId)).limit(1);
  if (rows[0]) return rows[0];
  const [row] = await db.insert(userOneClickSettingsTable).values({ userId }).returning();
  return row!;
}

type RubySettingsView = {
  rubyExecutionAuthority: string;
  aiInstantTradeCommandsEnabled: boolean;
  allowRubyOpenCommands: boolean;
  allowRubyCloseCommands: boolean;
  allowRubyModifyCommands: boolean;
  allowRubyBreakEven: boolean;
  allowRubyPartialClose: boolean;
  maxRubyLotPerTrade: number | null;
  maxRubyOpenPositions: number | null;
  maxRubyDailyTrades: number | null;
  allowedRubySymbols: string | null;
  allowedRubyAssetClasses: string | null;
};

function isRubySource(source: InstantTradeSource): boolean {
  return source === "ruby_text" || source === "ruby_voice";
}

function parseJsonStringArray(raw: string | null): string[] | null {
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) {
      const arr = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
      return arr.length > 0 ? arr : null;
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * Ruby authorization — runs only when source is ruby_text/ruby_voice.
 * AND-gated against every other live gate; NEVER relaxes the 16-gate dispatch.
 *
 * Source of truth is `rubyExecutionAuthority`:
 *   - OFF         → refuse (analysis only).
 *   - ADVISE_ONLY → refuse execution (Ruby proposes; user submits manually).
 *   - AI_AUTO     → refuse (defined, NOT enabled in this build).
 *   - AI_ASSISTED → permitted, subject to per-action perms + caps + allowlists.
 *
 * Sync portion: authority, per-action permissions, lot cap, and symbol/
 * asset-class allowlists. Per-Ruby count caps (open positions, daily trades)
 * are checked asynchronously in `rubyCapsCheck` because they query live state.
 */
function rubyAuthCheck(
  intent: InstantTradeIntent,
  settings: RubySettingsView,
): { ok: true } | { ok: false; reason: RubyAuthReason } {
  if (!isRubySource(intent.source)) return { ok: true };

  const authority = (settings.rubyExecutionAuthority ?? "OFF").trim().toUpperCase();
  if (authority === "ADVISE_ONLY") return { ok: false, reason: "RUBY_ADVISE_ONLY_MODE" };
  if (authority === "AI_AUTO") return { ok: false, reason: "RUBY_AI_AUTO_NOT_ENABLED" };
  if (authority !== "AI_ASSISTED") return { ok: false, reason: "RUBY_TRADING_NOT_ENABLED" };

  const kind = (intent.rubyCommandKind ?? "").trim().toUpperCase();
  const isOpen = intent.action === "BUY" || intent.action === "SELL";
  const isClose = intent.action === "CLOSE" || intent.action === "CLOSE_ALL";
  const isModify = intent.action === "MODIFY_SL_TP";

  if (isOpen && !settings.allowRubyOpenCommands) {
    return { ok: false, reason: "RUBY_OPEN_COMMANDS_NOT_ENABLED" };
  }
  if (isClose) {
    if (kind === "PARTIAL_CLOSE") {
      if (!settings.allowRubyPartialClose) return { ok: false, reason: "RUBY_PARTIAL_CLOSE_NOT_ENABLED" };
    } else if (!settings.allowRubyCloseCommands) {
      return { ok: false, reason: "RUBY_CLOSE_COMMANDS_NOT_ENABLED" };
    }
  }
  if (isModify) {
    if (kind === "MOVE_SL_TO_BREAKEVEN") {
      if (!settings.allowRubyBreakEven) return { ok: false, reason: "RUBY_BREAK_EVEN_NOT_ENABLED" };
    } else if (!settings.allowRubyModifyCommands) {
      return { ok: false, reason: "RUBY_MODIFY_COMMANDS_NOT_ENABLED" };
    }
  }

  // Risk-adding (OPEN) actions only: enforce the per-Ruby lot cap and the
  // Ruby symbol/asset-class allowlists. Reduce-risk actions (close/modify)
  // are NEVER blocked by an allowlist or lot cap — the user must always be
  // able to reduce live exposure via Ruby.
  if (isOpen) {
    if (settings.maxRubyLotPerTrade != null
      && typeof intent.volume === "number"
      && intent.volume > settings.maxRubyLotPerTrade) {
      return { ok: false, reason: "RUBY_LOT_CAP_EXCEEDED" };
    }
    const symbol = (intent.symbol ?? "").trim();
    const allowedSymbols = parseJsonStringArray(settings.allowedRubySymbols);
    if (allowedSymbols && symbol) {
      const want = symbol.toUpperCase();
      if (!allowedSymbols.some((s) => s.trim().toUpperCase() === want)) {
        return { ok: false, reason: "RUBY_SYMBOL_NOT_ALLOWED" };
      }
    }
    const allowedClasses = parseJsonStringArray(settings.allowedRubyAssetClasses);
    if (allowedClasses && symbol) {
      const cls = String(getSymbolProfile(symbol).assetClass).toLowerCase();
      if (!allowedClasses.some((c) => c.trim().toLowerCase() === cls)) {
        return { ok: false, reason: "RUBY_ASSET_CLASS_NOT_ALLOWED" };
      }
    }
  }

  return { ok: true };
}

/**
 * Per-Ruby COUNT caps — async because they read live state. OPEN actions only
 * (caps bound NEW risk). Enforced IN ADDITION to (never instead of) account
 * limits and the 16-gate dispatch.
 */
async function rubyCapsCheck(
  userId: number,
  intent: InstantTradeIntent,
  settings: RubySettingsView,
): Promise<{ ok: true } | { ok: false; reason: RubyAuthReason }> {
  if (!isRubySource(intent.source)) return { ok: true };
  if (intent.action !== "BUY" && intent.action !== "SELL") return { ok: true };

  if (settings.maxRubyOpenPositions != null) {
    const open = await db.select({ c: arxLivePositionsTable.id }).from(arxLivePositionsTable)
      .where(and(eq(arxLivePositionsTable.userId, userId), isNull(arxLivePositionsTable.closedAt)));
    if (open.length >= settings.maxRubyOpenPositions) {
      return { ok: false, reason: "RUBY_MAX_OPEN_POSITIONS_REACHED" };
    }
  }

  if (settings.maxRubyDailyTrades != null) {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const today = await db.select({ id: rubyCommandsTable.id }).from(rubyCommandsTable)
      .where(and(
        eq(rubyCommandsTable.userId, userId),
        eq(rubyCommandsTable.action, "OPEN_TRADE"),
        gte(rubyCommandsTable.createdAt, since),
        inArray(rubyCommandsTable.status, ["EXECUTING", "DISPATCHED", "COMPLETED"]),
      ));
    if (today.length >= settings.maxRubyDailyTrades) {
      return { ok: false, reason: "RUBY_DAILY_TRADE_LIMIT_REACHED" };
    }
  }

  return { ok: true };
}

export async function executeInstant(args: {
  userId: number;
  intent: InstantTradeIntent;
  ip?: string | null;
  ua?: string | null;
}): Promise<InstantTradeResult> {
  const { userId, intent, ip, ua } = args;

  if (intent.accountMode !== "live") {
    await writeAudit({
      userId, action: "INSTANT_EXECUTE_REJECTED", ip, ua,
      metadata: { intent, blockReason: "UNSUPPORTED_ACCOUNT_MODE_FOR_INSTANT_LIVE" },
    });
    return {
      ok: false, httpStatus: 400, error: "UNSUPPORTED_ACCOUNT_MODE_FOR_INSTANT_LIVE",
      detail: "Use the existing demo endpoints for non-live execution.",
    };
  }

  const settings = await getSettings(userId);
  // One-click toggle only gates NEW open-risk orders. Reduce-only actions
  // (CLOSE/CLOSE_ALL/MODIFY_SL_TP) must remain available regardless of
  // the one-click toggle so users can always reduce live risk — this
  // matches the legacy `/api/me/live/positions/:ticket/close` behavior
  // and is required for the "kill switch active → CLOSE ONLY" flow.
  const isOpenAction = intent.action === "BUY" || intent.action === "SELL";
  // One-click is active when the legacy typed-confirmation toggle OR the
  // new bridge-type-aware armed flag is on. Both still run all 16 Phase B
  // gates — the flag only removes the manual UI confirmation step.
  if (isOpenAction && !settings.liveOneClickEnabled && !settings.oneClickArmed) {
    await writeAudit({
      userId, action: "INSTANT_EXECUTE_REJECTED", ip, ua,
      metadata: { intent, blockReason: "LIVE_ONE_CLICK_DISABLED" },
    });
    return { ok: false, httpStatus: 412, error: "LIVE_ONE_CLICK_DISABLED" };
  }

  const rubyCheck = rubyAuthCheck(intent, settings);
  if (!rubyCheck.ok) {
    await writeAudit({
      userId, action: "INSTANT_EXECUTE_REJECTED", ip, ua,
      metadata: { intent, blockReason: rubyCheck.reason },
    });
    return { ok: false, httpStatus: 403, error: rubyCheck.reason, primaryReason: rubyCheck.reason };
  }
  const rubyCaps = await rubyCapsCheck(userId, intent, settings);
  if (!rubyCaps.ok) {
    await writeAudit({
      userId, action: "INSTANT_EXECUTE_REJECTED", ip, ua,
      metadata: { intent, blockReason: rubyCaps.reason },
    });
    return { ok: false, httpStatus: 403, error: rubyCaps.reason, primaryReason: rubyCaps.reason };
  }

  const access = await loadAndEvaluateUserMasterLiveAccessGate(userId);
  if (access.decision === "BLOCKED") {
    await writeAudit({
      userId, action: "INSTANT_EXECUTE_REJECTED", ip, ua,
      metadata: { intent, blockReason: access.primaryReason },
    });
    return {
      ok: false, httpStatus: 403, error: "MASTER_LIVE_USER_ACCESS_BLOCKED",
      primaryReason: access.primaryReason,
    };
  }

  // Per-user submit rate limit (tokens/min).
  if (!tryConsumeToken(`user:${userId}`, settings.perUserSubmitsPerMinute)) {
    await writeAudit({
      userId, action: "INSTANT_EXECUTE_REJECTED", ip, ua,
      metadata: { intent, blockReason: "USER_SUBMIT_RATE_LIMITED" },
    });
    return { ok: false, httpStatus: 429, error: "USER_SUBMIT_RATE_LIMITED" };
  }

  // AACI Security handshake (Phase 2) — advisory-additive defence-in-depth.
  // Only a BLOCK verdict (identity failure / default-deny) refuses; an
  // ALERT_ADMIN posture failure proceeds (the consult already alerted admins)
  // so a user can ALWAYS reduce live risk. Never relaxes any downstream gate.
  const hsAction =
    intent.action === "MODIFY_SL_TP"
      ? "MODIFY_SL_TP"
      : intent.action === "CLOSE" || intent.action === "CLOSE_ALL"
        ? "CLOSE_POSITION"
        : "LIVE_TRADE_EXECUTION";
  const hs = await enforceSensitiveAction(hsAction, { userId, authenticated: true });
  if (!hs.ok) {
    await writeAudit({
      userId, action: "INSTANT_EXECUTE_REJECTED", ip, ua,
      metadata: { intent, blockReason: hs.reasonCode },
    });
    return { ok: false, httpStatus: 403, error: hs.reasonCode, primaryReason: hs.reasonCode };
  }

  switch (intent.action) {
    case "BUY":
    case "SELL":
      return executeOpen({ userId, intent, settings, ip, ua });
    case "CLOSE":
      return executeClose({ userId, intent, ip, ua });
    case "CLOSE_ALL":
      return executeCloseAll({ userId, ip, ua });
    case "MODIFY_SL_TP":
      return executeModify({ userId, intent, ip, ua });
    default:
      await writeAudit({
        userId, action: "INSTANT_EXECUTE_REJECTED", ip, ua,
        metadata: { intent, blockReason: "UNKNOWN_ACTION" },
      });
      return { ok: false, httpStatus: 400, error: "UNKNOWN_ACTION" };
  }
}

async function executeOpen(args: {
  userId: number;
  intent: InstantTradeIntent;
  settings: { allowOrdersWithoutStopLoss: boolean; perUserSubmitsPerMinute: number };
  ip?: string | null; ua?: string | null;
}): Promise<InstantTradeResult> {
  const { userId, intent, settings, ip, ua } = args;
  const typedSymbol = (intent.symbol ?? "").trim();
  if (!typedSymbol) {
    await writeAudit({ userId, action: "INSTANT_EXECUTE_REJECTED", ip, ua, metadata: { intent, blockReason: "MISSING_SYMBOL" } });
    return { ok: false, httpStatus: 400, error: "MISSING_SYMBOL" };
  }
  // T033 Phase 6B — resolve the typed label to the EXACT enumerated broker
  // symbol BEFORE building the draft. Previously this path uppercased the raw
  // label (.toUpperCase()), which broke the case-sensitive broker-spec lookup
  // and gate-13 allowlist for case-sensitive names like "Volatility 75 Index"
  // (they'd reject). This mirrors the LiveSharedTradeTicket path: never submit
  // a display label as the execution symbol, never silently guess on ambiguity.
  // Accounts that have not enumerated symbols yet (no broker truth) fall back
  // to the trimmed typed string so they keep working as before.
  let symbol = typedSymbol;
  const resolution = await resolveBrokerSymbol(userId, typedSymbol);
  if (resolution.ok) {
    symbol = resolution.brokerSymbol; // exact, correctly-cased broker symbol
  } else if (resolution.reasonCode === "SYMBOL_AMBIGUOUS") {
    // Do NOT guess between e.g. "Volatility 75 Index" and "... (1s) Index".
    await writeAudit({ userId, action: "INSTANT_EXECUTE_REJECTED", ip, ua, metadata: { intent, blockReason: "SYMBOL_AMBIGUOUS", candidates: resolution.candidates.map((c) => c.brokerSymbol ?? c.symbol) } });
    return { ok: false, httpStatus: 409, error: "SYMBOL_AMBIGUOUS",
      primaryReason: "SYMBOL_AMBIGUOUS",
      detail: { candidates: resolution.candidates.map((c) => c.brokerSymbol ?? c.symbol) } };
  }
  // SYMBOL_NOT_FOUND / NO_BROKER_SYMBOL → keep the typed string and let the
  // live pipeline's broker-truth + allowlist gates decide (an unenumerated
  // account legitimately has no broker truth yet; a bad symbol gets rejected
  // downstream by gate 13 rather than silently mapped to a default).
  if (typeof intent.volume !== "number" || intent.volume <= 0) {
    await writeAudit({ userId, action: "INSTANT_EXECUTE_REJECTED", ip, ua, metadata: { intent, blockReason: "MISSING_VOLUME" } });
    return { ok: false, httpStatus: 400, error: "MISSING_VOLUME" };
  }
  const orderType = intent.orderType ?? (intent.action === "BUY" ? "MARKET_BUY" : "MARKET_SELL");
  const isMarket = /MARKET/i.test(orderType);
  const commandType: "PLACE_LIVE_MARKET_ORDER" | "PLACE_LIVE_PENDING_ORDER" =
    isMarket ? "PLACE_LIVE_MARKET_ORDER" : "PLACE_LIVE_PENDING_ORDER";

  if (!checkSymbolCooldown(symbol, userId)) {
    await writeAudit({ userId, action: "INSTANT_EXECUTE_REJECTED", ip, ua, metadata: { intent, blockReason: "SYMBOL_COOLDOWN" } });
    return { ok: false, httpStatus: 429, error: "SYMBOL_COOLDOWN" };
  }

  const noSlOverride = settings.allowOrdersWithoutStopLoss === true
    && (intent.stopLoss == null || intent.stopLoss <= 0);

  const prepareOnly = intent.prepareOnly === true;
  const lock = await withTxAdvisoryLock(ARX_LOCK_NS.USER_SUBMIT, userId, async () => {
    const draft = await createLiveDraft({
      userId, commandType, symbol, side: intent.action as "BUY" | "SELL", orderType,
      requestedVolume: intent.volume!, stopLoss: intent.stopLoss ?? null, takeProfit: intent.takeProfit ?? null,
      sourcePage: `INSTANT_${intent.source.toUpperCase()}`,
      rubyExplanationSummary: intent.rawUserCommand ?? null,
      payload: {},
      allowNoStopLossThisDraft: noSlOverride,
      selfTradeAgentId: intent.selfTradeAgentId ?? null,
      selfTradeDecisionId: intent.selfTradeDecisionId ?? null,
      selfTradeAgentKey: intent.selfTradeAgentKey ?? null,
      // Foundation gates #19/#20 — producer-supplied provenance envelope +
      // promotion-ledger reference (both optional; see InstantTradeIntent).
      provenance: intent.provenance ?? null,
      edgeId: intent.edgeId ?? null,
      missionId: intent.missionId ?? null,
    });
    if (!("ok" in draft) || draft.ok !== true) return { stage: "draft" as const, result: draft };
    // Task #213 — autonomy L1 (prepareOnly): the supervisor-approved draft is
    // created + attributed, but we STOP here. No confirm, no dispatch, no fill.
    // The draft sits in LIVE_CONFIRMATION_REQUIRED for human/operator action.
    if (prepareOnly) {
      return { stage: "draft" as const, result: { ok: true as const, command: draft.command }, commandId: draft.command.commandId, preparedOnly: true as const };
    }
    const confirmed = await confirmLiveCommand({ userId, commandId: draft.command.commandId });
    if (!confirmed.ok) return { stage: "confirm" as const, result: confirmed, commandId: draft.command.commandId };
    const dispatched = await dispatchLiveCommand({ userId, commandId: draft.command.commandId });
    return { stage: "dispatch" as const, result: dispatched, commandId: draft.command.commandId };
  });
  if (!lock.acquired) {
    await writeAudit({ userId, action: "INSTANT_EXECUTE_REJECTED", ip, ua, metadata: { intent, blockReason: "USER_SUBMIT_LOCKED" } });
    return { ok: false, httpStatus: 409, error: "USER_SUBMIT_LOCKED" };
  }
  const stage = lock.value;
  const draftR = stage.result as { ok?: boolean; reason?: string; primaryReason?: string; blockReason?: string; blockingReasonCode?: string };
  const accepted = draftR?.ok === true;
  await writeAudit({
    userId, action: accepted ? "INSTANT_EXECUTE_ACCEPTED" : "INSTANT_EXECUTE_REJECTED",
    ip, ua,
    metadata: {
      intent, stage: stage.stage, commandId: (stage as { commandId?: string }).commandId ?? null,
      noSlOverrideApplied: noSlOverride, serverLiveExecutionEnabled: liveBrokerExecutionEnabled(),
      primaryReason: draftR?.primaryReason ?? draftR?.blockReason ?? draftR?.reason ?? null,
    },
  });
  if (accepted) {
    // AACI warn-only manual advisory (Task #231): per-user cohesion read for a
    // manual trade that was just accepted. Fire-and-forget — never blocks, never
    // alerts, and never affects this already-placed trade. Self-trade has its
    // own pre-execution AACI gate, so skip it here.
    if (intent.source !== "self_trade" && (intent.action === "BUY" || intent.action === "SELL")) {
      void recordManualAaciAdvisory({
        userId,
        symbol: symbol!,
        side: intent.action,
        commandId: (stage as { commandId?: string }).commandId ?? null,
      });
    }
    return { ok: true, action: intent.action, commandId: (stage as { commandId?: string }).commandId, detail: draftR };
  }
  return {
    ok: false, httpStatus: 409,
    error: draftR?.blockReason ?? draftR?.reason ?? draftR?.primaryReason ?? "EXECUTE_REJECTED",
    primaryReason: draftR?.primaryReason ?? draftR?.blockReason ?? draftR?.reason,
    blockingReasonCode: draftR?.blockingReasonCode,
    detail: draftR,
  };
}

async function executeClose(args: {
  userId: number;
  intent: InstantTradeIntent;
  ip?: string | null; ua?: string | null;
}): Promise<InstantTradeResult> {
  const { userId, intent, ip, ua } = args;
  if (!intent.positionId) {
    await writeAudit({ userId, action: "INSTANT_CLOSE_REJECTED", ip, ua, metadata: { intent, blockReason: "MISSING_POSITION_ID" } });
    return { ok: false, httpStatus: 400, error: "MISSING_POSITION_ID" };
  }
  const pos = await db.select().from(arxLivePositionsTable)
    .where(and(
      eq(arxLivePositionsTable.userId, userId),
      eq(arxLivePositionsTable.brokerTicket, intent.positionId),
    )).limit(1);
  const row = pos[0];
  if (!row) {
    await writeAudit({ userId, action: "INSTANT_CLOSE_REJECTED", ip, ua, metadata: { intent, blockReason: "POSITION_NOT_FOUND" } });
    return { ok: false, httpStatus: 404, error: "POSITION_NOT_FOUND" };
  }

  // PARTIAL_CLOSE: reduce only the requested lots. We route through the SAME
  // CLOSE_LIVE_POSITION draft (which already takes a volume) — no new path.
  // A partial volume must be > 0 and strictly less than the full position;
  // anything >= the full size is treated as a normal full close.
  let closeVolume: number | undefined;
  if (typeof intent.closeVolume === "number" && intent.closeVolume > 0) {
    const full = Number(row.volume);
    if (intent.closeVolume < full) closeVolume = intent.closeVolume;
  }

  const r = await closeOnePosition({ userId, position: row, closeVolume });
  await writeAudit({
    userId, action: r.ok ? "INSTANT_CLOSE_ACCEPTED" : "INSTANT_CLOSE_REJECTED", ip, ua,
    metadata: {
      intent, positionId: intent.positionId, symbol: row.symbol,
      volume: closeVolume ?? Number(row.volume), partial: closeVolume != null,
      primaryReason: r.ok ? null : r.error,
    },
  });
  return r;
}

async function executeCloseAll(args: {
  userId: number; ip?: string | null; ua?: string | null;
}): Promise<InstantTradeResult> {
  const { userId, ip, ua } = args;
  const positions = await db.select().from(arxLivePositionsTable)
    .where(and(
      eq(arxLivePositionsTable.userId, userId),
      isNull(arxLivePositionsTable.closedAt),
    ));
  let closed = 0;
  const failures: Array<{ positionId: string | null; reason: string }> = [];
  for (const p of positions) {
    const r = await closeOnePosition({ userId, position: p });
    if (r.ok) closed += 1;
    else failures.push({ positionId: p.brokerTicket, reason: r.error });
  }
  const allOk = failures.length === 0;
  await writeAudit({
    userId, action: allOk ? "INSTANT_CLOSE_ALL_ACCEPTED" : "INSTANT_CLOSE_ALL_REJECTED", ip, ua,
    metadata: { total: positions.length, closed, failures },
  });
  return allOk
    ? { ok: true, action: "CLOSE_ALL", detail: { total: positions.length, closed } }
    : { ok: false, httpStatus: 207, error: "PARTIAL_CLOSE_ALL", detail: { total: positions.length, closed, failures } };
}

async function executeModify(args: {
  userId: number; intent: InstantTradeIntent; ip?: string | null; ua?: string | null;
}): Promise<InstantTradeResult> {
  const { userId, intent, ip, ua } = args;
  if (!intent.positionId) {
    await writeAudit({ userId, action: "INSTANT_EXECUTE_REJECTED", ip, ua, metadata: { intent, blockReason: "MISSING_POSITION_ID" } });
    return { ok: false, httpStatus: 400, error: "MISSING_POSITION_ID" };
  }
  const pos = await db.select().from(arxLivePositionsTable)
    .where(and(
      eq(arxLivePositionsTable.userId, userId),
      eq(arxLivePositionsTable.brokerTicket, intent.positionId),
    )).limit(1);
  const row = pos[0];
  if (!row) {
    await writeAudit({ userId, action: "INSTANT_EXECUTE_REJECTED", ip, ua, metadata: { intent, blockReason: "POSITION_NOT_FOUND" } });
    return { ok: false, httpStatus: 404, error: "POSITION_NOT_FOUND" };
  }

  const draft = await createLiveOpsDraft({
    userId,
    commandType: "MODIFY_LIVE_SLTP",
    brokerTicket: intent.positionId,
    symbol: row.symbol,
    side: row.side as "BUY" | "SELL",
    volume: Number(row.volume),
    newStopLoss: intent.newStopLoss ?? (row.stopLoss != null ? Number(row.stopLoss) : null),
    newTakeProfit: intent.newTakeProfit ?? (row.takeProfit != null ? Number(row.takeProfit) : null),
    sourcePage: `INSTANT_MODIFY_${intent.source.toUpperCase()}`,
  });
  if (!("ok" in draft) || draft.ok !== true) {
    const d = draft as { reason?: string; primaryReason?: string };
    await writeAudit({ userId, action: "INSTANT_EXECUTE_REJECTED", ip, ua, metadata: { intent, modify: true, blockReason: d.primaryReason ?? d.reason ?? "MODIFY_DRAFT_REJECTED" } });
    return { ok: false, httpStatus: 409, error: d.primaryReason ?? d.reason ?? "MODIFY_REJECTED", detail: d };
  }
  const confirmed = await confirmLiveCommand({ userId, commandId: draft.command.commandId });
  if (!confirmed.ok) {
    await writeAudit({ userId, action: "INSTANT_EXECUTE_REJECTED", ip, ua, metadata: { intent, modify: true, blockReason: confirmed.reason ?? "MODIFY_CONFIRM_FAILED", commandId: draft.command.commandId } });
    return { ok: false, httpStatus: 409, error: confirmed.reason ?? "CONFIRM_FAILED" };
  }
  const dispatched = await dispatchLiveCommand({ userId, commandId: draft.command.commandId });
  const accepted = dispatched.ok === true;
  const dispatchBlockReason = accepted
    ? null
    : ((dispatched as { primaryReason?: string; reason?: string }).primaryReason
      ?? (dispatched as { reason?: string }).reason
      ?? "MODIFY_DISPATCH_REJECTED");
  await writeAudit({
    userId, action: accepted ? "INSTANT_EXECUTE_ACCEPTED" : "INSTANT_EXECUTE_REJECTED", ip, ua,
    metadata: { intent, modify: true, commandId: draft.command.commandId, blockReason: dispatchBlockReason },
  });
  return accepted
    ? { ok: true, action: "MODIFY_SL_TP", commandId: draft.command.commandId }
    : { ok: false, httpStatus: 409, error: dispatched.primaryReason ?? dispatched.reason ?? "MODIFY_DISPATCH_REJECTED", detail: dispatched };
}

// Internal: dispatch ONE reduce-only CLOSE for a given position row.
// Uses createLiveOpsDraft so MISSING_STOP_LOSS is bypassed (close is
// reduce-only, the SL gate doesn't apply).
async function closeOnePosition(args: {
  userId: number;
  position: typeof arxLivePositionsTable.$inferSelect;
  // When set (PARTIAL_CLOSE), reduce only this many lots via the SAME
  // CLOSE_LIVE_POSITION draft. Must already be validated as > 0 and < full.
  closeVolume?: number;
}): Promise<InstantTradeResult> {
  const { userId, position, closeVolume } = args;
  if (!position.brokerTicket) return { ok: false, httpStatus: 400, error: "POSITION_MISSING_BROKER_TICKET" };
  const draft = await createLiveOpsDraft({
    userId,
    commandType: "CLOSE_LIVE_POSITION",
    brokerTicket: position.brokerTicket,
    symbol: position.symbol,
    side: position.side as "BUY" | "SELL",
    volume: closeVolume ?? Number(position.volume),
    sourcePage: "INSTANT_CLOSE",
  });
  if (!("ok" in draft) || draft.ok !== true) {
    const d = draft as { reason?: string; primaryReason?: string };
    return { ok: false, httpStatus: 409, error: d.primaryReason ?? d.reason ?? "CLOSE_REJECTED", detail: d };
  }
  const confirmed = await confirmLiveCommand({ userId, commandId: draft.command.commandId });
  if (!confirmed.ok) return { ok: false, httpStatus: 409, error: confirmed.reason ?? "CONFIRM_FAILED" };
  const dispatched = await dispatchLiveCommand({ userId, commandId: draft.command.commandId });
  return dispatched.ok === true
    ? { ok: true, action: "CLOSE", commandId: draft.command.commandId }
    : { ok: false, httpStatus: 409, error: dispatched.primaryReason ?? dispatched.reason ?? "CLOSE_DISPATCH_REJECTED", detail: dispatched };
}

/**
 * Dry-run validator — never inserts a command. Builds a draft and
 * immediately tears it down so callers (preview UI, Ruby preview) can
 * see whether dispatch WOULD pass without committing. Re-uses the same
 * preflight gates as the real path.
 */
export async function validateInstant(args: {
  userId: number; intent: InstantTradeIntent; ip?: string | null; ua?: string | null;
}): Promise<InstantTradeResult> {
  const { userId, intent, ip, ua } = args;
  // Always audit validate — it's a dry-run that still surfaces user
  // intent and the resulting decision (PASS or BLOCKED + reason).
  const audit = (decision: string, blockReason?: string) =>
    writeAudit({ userId, action: "INSTANT_VALIDATE", ip, ua, metadata: { intent, decision, blockReason: blockReason ?? null } });

  if (intent.accountMode !== "live") {
    await audit("BLOCKED", "UNSUPPORTED_ACCOUNT_MODE_FOR_INSTANT_LIVE");
    return { ok: false, httpStatus: 400, error: "UNSUPPORTED_ACCOUNT_MODE_FOR_INSTANT_LIVE" };
  }
  const settings = await getSettings(userId);
  // Mirror executeInstant(): the one-click toggle only gates BUY/SELL
  // open-risk previews. Reduce-only previews (CLOSE/CLOSE_ALL/
  // MODIFY_SL_TP) must remain available regardless of one-click.
  const isOpenAction = intent.action === "BUY" || intent.action === "SELL";
  // Mirror executeInstant(): check both legacy typed-confirmation toggle and
  // the new bridge-type-aware armed flag (Task #353).
  if (isOpenAction && !settings.liveOneClickEnabled && !settings.oneClickArmed) {
    await audit("BLOCKED", "LIVE_ONE_CLICK_DISABLED");
    return { ok: false, httpStatus: 412, error: "LIVE_ONE_CLICK_DISABLED" };
  }
  const ruby = rubyAuthCheck(intent, settings);
  if (!ruby.ok) {
    await audit("BLOCKED", ruby.reason);
    return { ok: false, httpStatus: 403, error: ruby.reason };
  }
  const access = await loadAndEvaluateUserMasterLiveAccessGate(userId);
  if (access.decision === "BLOCKED") {
    await audit("BLOCKED", "MASTER_LIVE_USER_ACCESS_BLOCKED");
    return { ok: false, httpStatus: 403, error: "MASTER_LIVE_USER_ACCESS_BLOCKED", primaryReason: access.primaryReason };
  }
  await audit("PASS");
  return { ok: true, action: intent.action, detail: { validate: true, serverLiveExecutionEnabled: liveBrokerExecutionEnabled() } };
}
