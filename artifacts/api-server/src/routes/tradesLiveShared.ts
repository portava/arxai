// Phase B (T004) — User-facing live shared-account trade endpoints.
//
// Mount path: /api/trades/live-shared/*
//
// SAFETY (inviolable):
// - Every endpoint goes through the existing Phase B pipeline
//   (createLiveDraft → confirmLiveCommand → dispatchLiveCommand) which
//   internally runs the 16-gate evaluator. NO direct broker calls.
// - Default-deny preserved: when ARX_LIVE_BROKER_EXECUTION_ENABLED is
//   unset/false, dispatch returns LIVE_BLOCKED with the legacy sentinel
//   BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED appended.
// - /validate is a true dry-run: it creates a draft to exercise preflight,
//   then IMMEDIATELY cancels it. No row can ever transition to
//   SENT_TO_MT5_LIVE from this endpoint. Validate rows always end in
//   LIVE_CANCELLED with rejectionReason="VALIDATE_DRYRUN".
// - /execute requires a typed confirmation phrase: "EXECUTE LIVE SHARED".
// - Per-user isolation: every load uses userId from req.authUser.
// - Modify/close go through createLiveOpsDraft (entry-only gates bypassed,
//   but kill-switch / master-switch / EA readiness still enforced).
// - shared_trade_attribution row is best-effort: written only when the
//   routing resolver returns both virtualAccountId and sharedMasterAccountId;
//   otherwise an audit-warn row is logged and the dispatch result is still
//   returned to the caller (the EA can still poll + execute).

import { Router, type Request } from "express";
import { and, eq, desc, isNull } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import {
  db,
  arxLiveCommandsTable,
  arxLivePositionsTable,
  sharedTradeAttributionTable,
  liveTradingAuditTable,
} from "@workspace/db";
import {
  createLiveDraft,
  createLiveOpsDraft,
  confirmLiveCommand,
  dispatchLiveCommand,
  cancelLiveCommand,
  listMyLiveCommands,
  getMyLiveCommand,
} from "../lib/live/liveCommandPipeline.js";
import { liveBrokerExecutionEnabled, resolveLiveBrokerExecutionEnabledAsync } from "../lib/live/phaseBConfig.js";
import { resolveRouting } from "../lib/adminTrading/routingResolver.js";
import { getUserRiskProfile, isOwnerRole } from "../lib/live/userRiskProfile.js";
import { resolveBrokerSymbol } from "../lib/mt5/symbolDirectory.js";
import { getBrokerSymbolSpec } from "../lib/mt5/brokerSymbolSpec.js";
import { sharedMasterAccountsTable, virtualTradingAccountsTable, globalTradingSettingsTable } from "@workspace/db/schema";
import { randomUUID } from "node:crypto";
import { routeCandles, routeQuote } from "../lib/data/marketDataRouter.js";
import { computeATR, classifyVolatility, type Candle } from "@workspace/domain/market";
import { buildExecutionPreviewForUser } from "../lib/execution/executionPreviewService.js";
import type {
  ExecutionPreviewSide,
  ExecutionOrderType,
} from "@workspace/domain/execution-preview";
import { mt5ConnectionTable } from "@workspace/db/schema";

const router = Router();

// T033 Phase 6B — server-side broker-symbol canonicalization.
//
// The client resolves the friendly label to an exact `brokerSymbol` before
// submitting, but the server must not blindly trust a client-supplied string.
// When a `brokerSymbol` is provided we re-resolve it against THIS user's own
// enumerated symbol directory and, on an exact resolve, replace it with the
// canonical broker string from that row (fixes case/spacing, defeats a spoofed
// label). When the directory can't resolve it — e.g. the user hasn't run
// ENUMERATE_SYMBOLS yet (empty directory) or a forex passthrough — we keep the
// provided value rather than hard-blocking, preserving the proven path; the
// 16-gate symbol allowlist (gate #13) remains the authoritative reject at
// dispatch. This NEVER enables execution and NEVER changes gate semantics.
async function canonicalizeBrokerSymbol(
  userId: number,
  provided: string | null,
  fallback: string,
): Promise<string> {
  if (!provided) return fallback;
  try {
    const r = await resolveBrokerSymbol(userId, provided);
    if (r.ok) return r.brokerSymbol;
  } catch {
    // resolution is best-effort hardening; never block the trade on it.
  }
  return provided;
}

const EXECUTE_PHRASE = "EXECUTE LIVE SHARED" as const;

function uid(req: Request): number | null {
  const u = (req as Request & { authUser?: { id?: number } }).authUser;
  return u?.id ?? null;
}

function envelope() {
  return {
    safetyMode: "phase_b_live_runtime_gated" as const,
    liveBrokerExecutionEnabled: liveBrokerExecutionEnabled(),
    liveDispatchEvaluator: "evaluateLivePhaseBDispatchGate" as const,
    liveExecutionDefaultDeny: true as const,
  };
}

async function auditWarn(args: {
  userId: number; eventType: string; message: string;
  symbol?: string; metadata?: Record<string, unknown>;
}) {
  try {
    await db.insert(liveTradingAuditTable).values({
      eventId: randomUUID(),
      eventType: args.eventType,
      severity: "WARNING",
      mode: "READ_ONLY",
      symbol: args.symbol ?? null,
      message: args.message,
      actorRole: "user",
      metadata: { userId: args.userId, ...(args.metadata ?? {}) },
    });
  } catch { /* audit-only failure */ }
}

// ── OWNER unrestricted recovery. Strictly scoped:
//   * Read-only: never inserts or updates any row.
//   * OWNER-only at the identity level: caller must already have proven
//     `isOwnerRole(userId) === true` AND `isOwnerUnrestricted === true`.
//     This double-guard means even an explicit "Owner Unrestricted Live"
//     template assigned to a non-OWNER does NOT trigger the fallback.
//   * Aligned to the active global shared-LIVE master: the recovered
//     shared_master_accounts row MUST link to the connection currently
//     designated as `global_trading_settings.shared_live_connection_id`.
//     Stale or unrelated rows are refused.
// Returns null if any constraint fails; the caller then surfaces the
// strict resolver block unchanged. Downstream Phase B gates
// (master switch, kill switch, EA heartbeat, broker acceptance, audit
// logging) still run.
export async function tryResolveOwnerSharedRouting(userId: number): Promise<{
  sharedMasterAccountId: number;
  virtualAccountId: number;
  connectionId: number;
} | null> {
  // (1) Anchor on the currently-active global shared-LIVE master.
  const [g] = await db.select({
    sharedLiveConnectionId: globalTradingSettingsTable.sharedLiveConnectionId,
  }).from(globalTradingSettingsTable).limit(1);
  const activeLiveConnId = g?.sharedLiveConnectionId ?? null;
  if (activeLiveConnId == null) return null;

  // (2) Find THE shared_master_accounts row that corresponds to the
  //     currently-active live connection. Status case-insensitive, but
  //     is_active must be true (not just casing).
  const smRows = await db.select({
    id: sharedMasterAccountsTable.id,
    connectionId: sharedMasterAccountsTable.connectionId,
    isActive: sharedMasterAccountsTable.isActive,
    status: sharedMasterAccountsTable.status,
    accountType: sharedMasterAccountsTable.accountType,
  }).from(sharedMasterAccountsTable)
    .where(and(
      eq(sharedMasterAccountsTable.connectionId, activeLiveConnId),
      eq(sharedMasterAccountsTable.accountType, "live"),
    )).limit(1);
  const smRow = smRows[0];
  if (!smRow) return null;
  if (smRow.isActive !== true) return null;
  if (String(smRow.status ?? "").toLowerCase() !== "active") return null;

  // (3) Find the user's virtual_trading_accounts row that maps to THAT
  //     specific shared_master row. Status case-insensitive only.
  const vAccRows = await db.select({
    id: virtualTradingAccountsTable.id,
    status: virtualTradingAccountsTable.status,
  }).from(virtualTradingAccountsTable)
    .where(and(
      eq(virtualTradingAccountsTable.userId, userId),
      eq(virtualTradingAccountsTable.sharedMasterAccountId, smRow.id),
      eq(virtualTradingAccountsTable.accountType, "live"),
    )).limit(1);
  const vAcc = vAccRows[0];
  if (!vAcc) return null;
  if (String(vAcc.status ?? "").toLowerCase() !== "active") return null;

  return {
    sharedMasterAccountId: smRow.id,
    virtualAccountId: vAcc.id,
    connectionId: smRow.connectionId,
  };
}

// Soft resolver block reasons that the OWNER fallback is allowed to
// recover from. These are limited to the documented casing/normalisation
// issues; real policy failures (no master configured, shared LIVE not
// explicitly enabled, type mismatch, hard inactive, etc.) intentionally
// remain blocking even for OWNER.
const OWNER_FALLBACK_ALLOWED_BLOCK_REASONS: ReadonlySet<string> = new Set([
  "VIRTUAL_ACCOUNT_ACTIVE", // 'ACTIVE' vs 'active' case bug — the documented soft case.
]);

// ── Shared-routing precondition. This router is the LIVE-SHARED surface;
// it must refuse any user whose effective routing is not
// SHARED_MASTER_MT5 with both sharedMasterAccountId and virtualAccountId
// resolved. Returning the routing object lets the caller reuse the IDs.
//
// OWNER UNRESTRICTED FALLBACK (owner-indestructible-live-shared-profile):
//   Activates ONLY when ALL of the following hold:
//     1. `getUserRiskProfile(userId).isOwnerUnrestricted === true`, AND
//     2. `isOwnerRole(userId) === true` (strict identity check —
//        explicitly-assigned non-OWNER templates do NOT qualify), AND
//     3. The strict resolver block is in `OWNER_FALLBACK_ALLOWED_BLOCK_REASONS`
//        (the documented soft-casing set) OR the resolver returned ok=true
//        but partial IDs.
//   When all three hold and `tryResolveOwnerSharedRouting` recovers a
//   valid tuple aligned to the active global shared-LIVE master, the
//   synthesized routing is returned. Failed recovery is audit-warned
//   (`OWNER_SHARED_ROUTING_FALLBACK_FAILED`). Normal users are NEVER
//   affected — they continue to see the strict resolver outcome verbatim.
//   The downstream Phase B 16-gate evaluator, kill switch, master switch,
//   bridge heartbeat, EA flags, broker acceptance and audit logging are
//   all re-checked and remain in full force.
async function requireSharedRouting(userId: number) {
  const routing = await resolveRouting({ userId, mode: "LIVE" });
  const fullyResolved = routing.ok
    && routing.effectiveRoutingMode === "SHARED_MASTER_MT5"
    && routing.sharedMasterAccountId != null
    && routing.virtualAccountId != null
    && routing.connectionId != null;
  if (fullyResolved) {
    return { ok: true as const, routing };
  }

  // OWNER unrestricted fallback — strict identity + soft-reason allowlist.
  const profile = await getUserRiskProfile(userId);
  const ownerIdentity = profile.isOwnerUnrestricted ? await isOwnerRole(userId) : false;
  const blockReason = routing.blockReason ?? null;
  const isAllowedSoftBlock = !routing.ok
    ? (blockReason != null && OWNER_FALLBACK_ALLOWED_BLOCK_REASONS.has(blockReason))
    : true; // ok=true with partial IDs is always a recoverable soft case.
  if (profile.isOwnerUnrestricted && ownerIdentity && isAllowedSoftBlock) {
    const ownerIds = await tryResolveOwnerSharedRouting(userId);
    if (ownerIds) {
      const synthesized = {
        ok: true,
        effectiveRoutingMode: "SHARED_MASTER_MT5" as const,
        connectionId: ownerIds.connectionId,
        connectionType: "shared_master" as const,
        accountType: "live" as const,
        sharedMasterAccountId: ownerIds.sharedMasterAccountId,
        virtualAccountId: ownerIds.virtualAccountId,
        blockReason: null,
        notes: [
          ...routing.notes,
          `owner-unrestricted-shared-routing-fallback:${blockReason ?? "resolver_returned_partial"}`,
        ],
      };
      await auditWarn({
        userId,
        eventType: "OWNER_SHARED_ROUTING_FALLBACK_USED",
        message: `OWNER bypass recovered shared routing IDs (strict resolver blocked: ${blockReason ?? "partial-resolution"}).`,
        metadata: {
          ownerIds,
          strictBlockReason: blockReason,
          strictRoutingMode: routing.effectiveRoutingMode,
        },
      });
      return { ok: true as const, routing: synthesized };
    }
    // OWNER passed identity + soft-block allowlist but recovery still
    // failed (e.g. no existing rows aligned to the active master). Audit
    // so the operator can fix infra, then fall through to strict block.
    await auditWarn({
      userId,
      eventType: "OWNER_SHARED_ROUTING_FALLBACK_FAILED",
      message: `OWNER bypass attempted but no aligned shared/virtual rows found (strict resolver blocked: ${blockReason ?? "partial-resolution"}).`,
      metadata: {
        strictBlockReason: blockReason,
        strictRoutingMode: routing.effectiveRoutingMode,
      },
    });
  }

  if (!routing.ok) {
    return { ok: false as const, status: 409, body: {
      error: "ROUTING_NOT_RESOLVED",
      detail: routing.blockReason ?? "resolveRouting returned ok=false",
      ...envelope(),
    } };
  }
  if (routing.effectiveRoutingMode !== "SHARED_MASTER_MT5") {
    return { ok: false as const, status: 409, body: {
      error: "ROUTING_NOT_SHARED_MASTER",
      detail: `Live shared route requires SHARED_MASTER_MT5, got ${routing.effectiveRoutingMode}`,
      ...envelope(),
    } };
  }
  return { ok: false as const, status: 409, body: {
    error: "SHARED_ROUTING_MISSING_IDS",
    detail: "shared_master_account_id / virtual_account_id / connection_id must all be resolved",
    ...envelope(),
  } };
}

// ── POST /validate — dry-run via draft+cancel. No SENT_TO_MT5_LIVE row ever.
router.post("/trades/live-shared/validate", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const shared = await requireSharedRouting(userId);
  if (!shared.ok) { res.status(shared.status).json(shared.body); return; }
  const b = req.body ?? {};
  const side = b.side === "SELL" ? "SELL" : "BUY";
  // T033 Phase 6B — the client resolves the friendly label to an exact broker
  // symbol via the symbol directory and sends it as `brokerSymbol`. Prefer it
  // for execution; `symbol` remains the friendly label for UI/audit. When the
  // client did not send one (older client), fall back to the typed symbol —
  // the EA-side preflight resolver still selects the exact symbol downstream.
  // The provided brokerSymbol is re-resolved server-side (canonicalize, never
  // trust the raw client string); see canonicalizeBrokerSymbol.
  const displaySymbol = String(b.symbol ?? "").toUpperCase();
  const brokerSymbol = b.brokerSymbol != null ? String(b.brokerSymbol) : null;
  const symbol = await canonicalizeBrokerSymbol(userId, brokerSymbol, displaySymbol);
  const volume = Number(b.volume ?? 0);
  if (!symbol) { res.status(400).json({ error: "SYMBOL_REQUIRED", ...envelope() }); return; }
  if (!Number.isFinite(volume) || volume <= 0) {
    res.status(400).json({ error: "VOLUME_REQUIRED", ...envelope() }); return;
  }
  const stopLoss = b.stopLoss != null ? Number(b.stopLoss) : null;
  const takeProfit = b.takeProfit != null ? Number(b.takeProfit) : null;

  const draft = await createLiveDraft({
    userId,
    commandType: "PLACE_LIVE_MARKET_ORDER",
    symbol, side,
    orderType: side === "SELL" ? "MARKET_SELL" : "MARKET_BUY",
    requestedVolume: volume,
    stopLoss, takeProfit,
    sourcePage: "TRADES_LIVE_SHARED_VALIDATE",
    rubyExplanationSummary: "validate dry-run",
    payload: { validateDryRun: true },
  });
  if (!draft.ok) {
    res.status(200).json({
      ok: false, stage: "preflight",
      reason: draft.reason, detail: draft.detail ?? null,
      ...envelope(),
    });
    return;
  }
  // Immediately cancel so the row never reaches dispatch. If cancel fails
  // for any reason, we MUST report failure so the operator knows a draft
  // row is sitting in LIVE_CONFIRMATION_REQUIRED.
  const cancelled = await cancelLiveCommand({
    userId, commandId: draft.command.commandId,
    reason: "VALIDATE_DRYRUN",
  });
  if (!cancelled.ok) {
    await auditWarn({
      userId, eventType: "VALIDATE_CANCEL_FAILED", symbol,
      message: `Validate dry-run cancel failed; draft left in non-terminal state`,
      metadata: { commandId: draft.command.commandId, cancelReason: cancelled.reason },
    });
    res.status(500).json({
      ok: false, stage: "validate_cancel_failed",
      commandId: draft.command.commandId,
      cancelResult: cancelled,
      detail: "Draft created but could not be cancelled. Call /cancel manually.",
      ...envelope(),
    });
    return;
  }
  res.status(200).json({
    ok: true, stage: "preflight_passed",
    commandId: draft.command.commandId,
    cancelled: true,
    note: "Preflight gates passed. Run /execute with confirmationIntent to actually dispatch.",
    ...envelope(),
  });
});

// ── POST /execute — typed-phrase gated; draft → confirm → dispatch; writes
// shared_trade_attribution as a required step on dispatch success.
router.post("/trades/live-shared/execute", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const shared = await requireSharedRouting(userId);
  if (!shared.ok) { res.status(shared.status).json(shared.body); return; }
  const routing = shared.routing;
  const b = req.body ?? {};
  if (String(b.confirmationIntent ?? "") !== EXECUTE_PHRASE) {
    res.status(400).json({
      error: "CONFIRMATION_INTENT_MISMATCH",
      detail: `Type exactly: ${EXECUTE_PHRASE}`,
      requiredPhrase: EXECUTE_PHRASE,
      ...envelope(),
    });
    return;
  }
  const side = b.side === "SELL" ? "SELL" : "BUY";
  // T033 Phase 6B — mirror the /validate route: the client resolves the
  // friendly label to an exact broker symbol via the symbol directory and sends
  // it as `brokerSymbol`. Prefer it for execution (broker symbols are
  // case-sensitive — uppercasing a display label would corrupt synthetics like
  // "Volatility 75 Index"). When absent (older client) fall back to the typed
  // label; the live-poll boundary resolver still selects the exact symbol.
  // The provided brokerSymbol is re-resolved server-side (canonicalize, never
  // trust the raw client string); see canonicalizeBrokerSymbol.
  const displaySymbol = String(b.symbol ?? "").toUpperCase();
  const brokerSymbol = b.brokerSymbol != null ? String(b.brokerSymbol) : null;
  const symbol = await canonicalizeBrokerSymbol(userId, brokerSymbol, displaySymbol);
  const volume = Number(b.volume ?? 0);
  if (!symbol) { res.status(400).json({ error: "SYMBOL_REQUIRED", ...envelope() }); return; }
  if (!Number.isFinite(volume) || volume <= 0) {
    res.status(400).json({ error: "VOLUME_REQUIRED", ...envelope() }); return;
  }
  const stopLoss = b.stopLoss != null ? Number(b.stopLoss) : null;
  const takeProfit = b.takeProfit != null ? Number(b.takeProfit) : null;
  // SL pre-check is conditional on the user's risk profile. The Phase B
  // 16-gate (MISSING_STOP_LOSS) is the authoritative check and already
  // honors `requireStopLoss`, `adminAllowNoStopLoss`, and the OWNER
  // unrestricted override. We only short-circuit here for users whose
  // profile actually requires an SL, so the OWNER unrestricted profile
  // (and admin-allow overrides) can pass straight through to dispatch.
  const ownerUnrestricted =
    (await isOwnerRole(userId))
    && (await getUserRiskProfile(userId)).isOwnerUnrestricted;
  if (!ownerUnrestricted && (stopLoss == null || stopLoss <= 0)) {
    res.status(400).json({
      error: "STOP_LOSS_REQUIRED",
      detail: "Live shared dispatch requires an explicit stopLoss > 0.",
      ...envelope(),
    });
    return;
  }

  // QA enrichment: every queued shared-live command must carry an
  // internalTradeId + accountMode + tradingMode + risk snapshot in payload.
  // Validation snapshot (dispatchGateSnapshot) and confirmation timestamp
  // (confirmedAt) are set by the pipeline; we attach the rest here.
  const internalTradeId = `arx_trade_${randomUUID()}`;
  const riskSnapshot = {
    symbol, side, requestedVolume: volume,
    stopLoss, takeProfit,
    riskRewardRatio: (stopLoss != null && takeProfit != null && stopLoss > 0)
      ? Math.abs((takeProfit - 0) / Math.max(stopLoss, 1e-9))
      : null,
    capturedAt: new Date().toISOString(),
  };
  const draft = await createLiveDraft({
    userId,
    commandType: "PLACE_LIVE_MARKET_ORDER",
    symbol, side,
    orderType: side === "SELL" ? "MARKET_SELL" : "MARKET_BUY",
    requestedVolume: volume,
    stopLoss, takeProfit,
    sourcePage: "TRADES_LIVE_SHARED_EXECUTE",
    rubyExplanationSummary: typeof b.rubyExplanationSummary === "string"
      ? b.rubyExplanationSummary : null,
    payload: {
      tradesLiveShared: true,
      internalTradeId,
      accountMode: "SHARED" as const,
      tradingMode: "LIVE" as const,
      sharedMasterAccountId: routing.sharedMasterAccountId,
      virtualAccountId: routing.virtualAccountId,
      masterConnectionId: routing.connectionId,
      riskSnapshot,
    },
  });
  if (!draft.ok) {
    res.status(409).json({ stage: "preflight", ...draft, ...envelope() });
    return;
  }
  const conf = await confirmLiveCommand({ userId, commandId: draft.command.commandId });
  if (!conf.ok) {
    res.status(409).json({ stage: "confirm", ...conf, commandId: draft.command.commandId, ...envelope() });
    return;
  }

  // FAIL-CLOSED ATTRIBUTION: insert shared_trade_attribution BEFORE dispatch.
  // If the insert fails, the command is still LIVE_APPROVED (not yet
  // SENT_TO_MT5_LIVE) so we can safely cancel it; the EA can never pick up
  // a command that has no attribution row. After dispatch we update the
  // attribution row to 'open' on PASS or 'rejected' on BLOCK.
  let attributionId: number | null = null;
  try {
    const [attr] = await db.insert(sharedTradeAttributionTable).values({
      userId,
      virtualAccountId: routing.virtualAccountId!,
      sharedMasterAccountId: routing.sharedMasterAccountId!,
      masterConnectionId: routing.connectionId!,
      symbol, side, lotSize: volume,
      stopLoss, takeProfit,
      status: "pending",
    }).returning({ id: sharedTradeAttributionTable.id });
    attributionId = attr?.id ?? null;
    if (attributionId == null) throw new Error("attribution insert returned no id");
  } catch (e) {
    const msg = (e as Error).message;
    await auditWarn({
      userId, eventType: "ATTRIBUTION_PRE_DISPATCH_FAILED", symbol,
      message: `shared_trade_attribution insert failed before dispatch: ${msg}`,
      metadata: { commandId: draft.command.commandId },
    });
    // FAIL-CLOSED CASCADE: render the LIVE_APPROVED command permanently
    // non-dispatchable so the alternate dispatch path (/me/live/commands/:id/dispatch)
    // cannot pick it up. Three layers:
    //   1) cancelLiveCommand (clean transition)
    //   2) direct DB UPDATE to LIVE_BLOCKED (legal transition from LIVE_APPROVED)
    //   3) HIGH-severity audit if both fail
    let madeTerminal = false;
    const cancelRes = await cancelLiveCommand({
      userId, commandId: draft.command.commandId,
      reason: "ATTRIBUTION_INSERT_FAILED",
    }).catch(() => ({ ok: false as const, reason: "CANCEL_THREW" as const }));
    if (cancelRes.ok) { madeTerminal = true; }
    else {
      try {
        await db.update(arxLiveCommandsTable).set({
          status: "LIVE_BLOCKED",
          rejectionReason: "ATTRIBUTION_INSERT_FAILED",
          rejectedAt: new Date(),
        }).where(and(
          eq(arxLiveCommandsTable.commandId, draft.command.commandId),
          eq(arxLiveCommandsTable.userId, userId),
        ));
        madeTerminal = true;
      } catch (e2) {
        await db.insert(liveTradingAuditTable).values({
          eventId: randomUUID(),
          eventType: "ATTRIBUTION_FAILSAFE_CASCADE_FAILED",
          severity: "HIGH",
          mode: "READ_ONLY",
          symbol,
          message: `CRITICAL: attribution insert AND cancel AND force-block all failed for ${draft.command.commandId}. Manual ops intervention required.`,
          actorRole: "user",
          metadata: {
            userId, commandId: draft.command.commandId,
            attributionError: msg,
            cancelReason: (cancelRes as { reason?: string }).reason,
            forceBlockError: (e2 as Error).message,
          },
        }).catch(() => undefined);
      }
    }
    res.status(500).json({
      ok: false, stage: "attribution_pre_dispatch_failed",
      commandId: draft.command.commandId,
      reason: "ATTRIBUTION_INSERT_FAILED",
      detail: msg,
      commandRenderedTerminal: madeTerminal,
      ...envelope(),
    });
    return;
  }

  const disp = await dispatchLiveCommand({ userId, commandId: draft.command.commandId });

  // Reflect dispatch outcome into the attribution row.
  try {
    await db.update(sharedTradeAttributionTable).set({
      status: disp.ok ? "open" : "rejected",
      rejectionReason: disp.ok ? null
        : ((disp as { primaryReason?: string }).primaryReason ?? "DISPATCH_BLOCKED"),
      updatedAt: new Date(),
    }).where(eq(sharedTradeAttributionTable.id, attributionId));
  } catch (e) {
    await auditWarn({
      userId, eventType: "ATTRIBUTION_POST_DISPATCH_UPDATE_FAILED", symbol,
      message: `attribution post-dispatch status update failed: ${(e as Error).message}`,
      metadata: { commandId: draft.command.commandId, attributionId },
    });
  }

  res.status(disp.ok ? 200 : 409).json({
    ...disp,
    commandId: draft.command.commandId,
    attributionId,
    ...envelope(),
  });
});

// ── POST /cancel — cancel an in-flight draft/confirmation.
router.post("/trades/live-shared/cancel", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const commandId = String(req.body?.commandId ?? "");
  if (!commandId) { res.status(400).json({ error: "COMMAND_ID_REQUIRED", ...envelope() }); return; }
  const reason = String(req.body?.reason ?? "USER_CANCELLED");
  const result = await cancelLiveCommand({ userId, commandId, reason });
  res.status(result.ok ? 200 : 409).json({ ...result, ...envelope() });
});

// ── POST /positions/:ticket/close — emergency close via createLiveOpsDraft.
router.post("/trades/live-shared/positions/:ticket/close", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const sharedC = await requireSharedRouting(userId);
  if (!sharedC.ok) { res.status(sharedC.status).json(sharedC.body); return; }
  const ticket = String(req.params.ticket);
  const rows = await db.select().from(arxLivePositionsTable)
    .where(and(
      eq(arxLivePositionsTable.userId, userId),
      eq(arxLivePositionsTable.brokerTicket, ticket),
    )).limit(1);
  const pos = rows[0];
  // Answer with the same shape every other refusal on this router uses:
  // `ok:false` plus a reason the UI can show verbatim. Returning a bare
  // `error` here made the client render "Close blocked: unknown", because it
  // reads `primaryReason ?? reason` — an unexplainable dead end on a row the
  // position table no longer has (already closed, or never a position at all).
  if (!pos) {
    res.status(404).json({
      ok: false,
      error: "POSITION_NOT_FOUND",
      reason: "POSITION_NOT_FOUND",
      primaryReason: `No open live position with ticket ${ticket} is on your account. It may already be closed — refresh the list.`,
      ...envelope(),
    });
    return;
  }
  const draft = await createLiveOpsDraft({
    userId,
    commandType: "CLOSE_LIVE_POSITION",
    brokerTicket: ticket,
    symbol: pos.symbol,
    side: pos.side === "SELL" ? "SELL" : "BUY",
    volume: Number(pos.volume),
    sourcePage: "TRADES_LIVE_SHARED_CLOSE",
  });
  if (!draft.ok) { res.status(409).json({ ...draft, ...envelope() }); return; }
  const conf = await confirmLiveCommand({ userId, commandId: draft.command.commandId });
  if (!conf.ok) { res.status(409).json({ ...conf, commandId: draft.command.commandId, ...envelope() }); return; }
  const disp = await dispatchLiveCommand({ userId, commandId: draft.command.commandId });
  res.status(disp.ok ? 200 : 409).json({ ...disp, commandId: draft.command.commandId, ...envelope() });
});

// ── POST /positions/:ticket/modify — SL/TP modify.
router.post("/trades/live-shared/positions/:ticket/modify", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const sharedM = await requireSharedRouting(userId);
  if (!sharedM.ok) { res.status(sharedM.status).json(sharedM.body); return; }
  const ticket = String(req.params.ticket);
  const b = req.body ?? {};
  const newStopLoss = b.stopLoss != null ? Number(b.stopLoss) : null;
  const newTakeProfit = b.takeProfit != null ? Number(b.takeProfit) : null;
  if (newStopLoss == null && newTakeProfit == null) {
    res.status(400).json({ error: "NO_FIELDS_TO_MODIFY", detail: "Provide stopLoss and/or takeProfit", ...envelope() });
    return;
  }
  const rows = await db.select().from(arxLivePositionsTable)
    .where(and(
      eq(arxLivePositionsTable.userId, userId),
      eq(arxLivePositionsTable.brokerTicket, ticket),
    )).limit(1);
  const pos = rows[0];
  // Answer with the same shape every other refusal on this router uses:
  // `ok:false` plus a reason the UI can show verbatim. Returning a bare
  // `error` here made the client render "Close blocked: unknown", because it
  // reads `primaryReason ?? reason` — an unexplainable dead end on a row the
  // position table no longer has (already closed, or never a position at all).
  if (!pos) {
    res.status(404).json({
      ok: false,
      error: "POSITION_NOT_FOUND",
      reason: "POSITION_NOT_FOUND",
      primaryReason: `No open live position with ticket ${ticket} is on your account. It may already be closed — refresh the list.`,
      ...envelope(),
    });
    return;
  }
  const draft = await createLiveOpsDraft({
    userId,
    commandType: "MODIFY_LIVE_SLTP",
    brokerTicket: ticket,
    symbol: pos.symbol,
    side: pos.side === "SELL" ? "SELL" : "BUY",
    volume: Number(pos.volume),
    newStopLoss, newTakeProfit,
    sourcePage: "TRADES_LIVE_SHARED_MODIFY",
  });
  if (!draft.ok) { res.status(409).json({ ...draft, ...envelope() }); return; }
  const conf = await confirmLiveCommand({ userId, commandId: draft.command.commandId });
  if (!conf.ok) { res.status(409).json({ ...conf, commandId: draft.command.commandId, ...envelope() }); return; }
  const disp = await dispatchLiveCommand({ userId, commandId: draft.command.commandId });
  res.status(disp.ok ? 200 : 409).json({ ...disp, commandId: draft.command.commandId, ...envelope() });
});

// Project arx_live_commands rows into a strict user-facing DTO. We use an
// allowlist (not a blacklist) so any new operator-only column added to the
// schema is OFF by default for users until explicitly opted in here.
//
// REDACTED (operator/diagnostic only — never reach the user surface):
//   bridgeConnectionId, accountLogin, brokerServer, accountNumber,
//   sourcePage, idempotencyKey, dispatchGateSnapshot, payload.
//
// The DB row is preserved unchanged; only the user-visible projection is
// trimmed. Admin/operator endpoints that legitimately need the full row
// MUST query the table directly and gate via AdminDiagnosticsGate.
const USER_COMMAND_KEYS = [
  "id", "commandId", "userId",
  "commandType", "status",
  "symbol", "side", "orderType",
  "requestedVolume", "executedVolume", "stopLoss", "takeProfit",
  "rubyExplanationSummary",
  "brokerTicket", "fillPrice", "mt5Retcode", "brokerMessage", "rejectionReason",
  "createdAt", "confirmedAt", "sentToMt5At", "pickedByEaAt", "filledAt", "rejectedAt", "closedAt",
] as const;
function projectCommandForUser<T extends Record<string, unknown> | null | undefined>(cmd: T): Record<string, unknown> | null {
  if (!cmd) return null;
  const out: Record<string, unknown> = {};
  const src = cmd as Record<string, unknown>;
  for (const k of USER_COMMAND_KEYS) {
    if (k in src) out[k] = src[k];
  }
  return out;
}

// Project an arx_live_positions row into a strict user-facing DTO. Allowlist,
// same discipline as USER_COMMAND_KEYS: bridgeConnectionId, accountLogin,
// brokerServer, reconcile* and the broker-absence evidence columns are
// operator-only and never leave this projection.
function projectPositionForUser(p: typeof arxLivePositionsTable.$inferSelect) {
  return {
    brokerTicket: p.brokerTicket,
    symbol: p.symbol,
    side: p.side,
    volume: p.volume,
    entryPrice: p.entryPrice,
    currentPrice: p.currentPrice,
    floatingPl: p.floatingPl,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
    openedAt: p.openedAt ? p.openedAt.toISOString() : null,
    lastSyncedAt: p.lastSyncedAt ? p.lastSyncedAt.toISOString() : null,
    managementState: p.managementState,
    sourceCommandId: p.sourceCommandId,
  };
}

// ── GET /positions — the caller's OPEN live positions, read from
// arx_live_positions: the same table /positions/:ticket/close and
// /positions/:ticket/modify resolve a ticket against.
//
// This exists because the Open Positions list used to be derived from the
// COMMAND LOG, which is not a position list: a CLOSE_LIVE_POSITION and a
// MODIFY_LIVE_SLTP row both carry a brokerTicket, nothing retires the original
// PLACE row when the position closes, so a closed position stayed listed
// forever and its close command appeared as an extra "open position" with its
// own Close button. That overstated live exposure and produced Close presses
// against tickets the position table no longer had.
router.get("/trades/live-shared/positions", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const rows = await db.select().from(arxLivePositionsTable)
    .where(and(
      eq(arxLivePositionsTable.userId, userId),
      isNull(arxLivePositionsTable.closedAt),
    ))
    .orderBy(desc(arxLivePositionsTable.openedAt))
    .limit(200);
  res.json({
    ok: true,
    positions: rows.map(projectPositionForUser),
    ...envelope(),
  });
});

// ── GET /commands — per-user list (read-only).
router.get("/trades/live-shared/commands", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  const rows = await listMyLiveCommands({ userId, limit });
  res.json({ commands: rows.map(r => projectCommandForUser(r as Record<string, unknown>)), ...envelope() });
});

// ── GET /commands/:commandId — per-user single (read-only).
router.get("/trades/live-shared/commands/:commandId", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const cmd = await getMyLiveCommand(userId, String(req.params.commandId));
  if (!cmd) { res.status(404).json({ error: "COMMAND_NOT_FOUND", ...envelope() }); return; }
  res.json({ command: projectCommandForUser(cmd as unknown as Record<string, unknown>), ...envelope() });
});

// ── GET /attributions — per-user attribution rows (read-only).
router.get("/trades/live-shared/attributions", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const limit = req.query.limit ? Math.min(Math.max(Number(req.query.limit), 1), 200) : 50;
  const rows = await db.select().from(sharedTradeAttributionTable)
    .where(eq(sharedTradeAttributionTable.userId, userId))
    .orderBy(desc(sharedTradeAttributionTable.id))
    .limit(limit);
  res.json({ attributions: rows, ...envelope() });
});

// ── GET /suggest-sltp — advisory SL/TP suggestion (READ-ONLY) ────────────
//
// Given a symbol + side (+ optional reference entry), derive a suggested
// stop-loss and take-profit from the live market's recent volatility:
//   SL distance = 1.5 × ATR(14) on M15 candles
//   TP distance = 2 × SL distance   (2:1 reward:risk)
//   BUY  → SL = entry − slDist, TP = entry + tpDist
//   SELL → SL = entry + slDist, TP = entry − tpDist
//
// This is purely advisory: it places NO order, queues NOTHING for the EA,
// touches NO safety surface, and is never an execution gate. The client
// prefills the editable SL/TP fields with these values; the user can change
// or clear them, and the 16-gate evaluator still runs on /execute. Candles
// are real (via the unified market data router) or we return an honest
// insufficient-data response — never fabricated.
function inferDecimals(price: number): number {
  const abs = Math.abs(price);
  if (abs === 0) return 5;
  if (abs >= 1000) return 2;   // indices / XAUUSD (~2400)
  if (abs >= 10) return 3;     // JPY pairs (~150)
  return 5;                    // major forex (~1.16)
}
function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

router.get("/trades/live-shared/suggest-sltp", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }

  const symbolRaw = typeof req.query.symbol === "string" ? req.query.symbol.trim() : "";
  const sideRaw = typeof req.query.side === "string" ? req.query.side.trim().toUpperCase() : "";
  if (!symbolRaw) { res.status(400).json({ ok: false, error: "MISSING_SYMBOL", ...envelope() }); return; }
  if (sideRaw !== "BUY" && sideRaw !== "SELL") {
    res.status(400).json({ ok: false, error: "INVALID_SIDE", ...envelope() }); return;
  }
  const side = sideRaw as "BUY" | "SELL";
  const entryParam = typeof req.query.entry === "string" && req.query.entry.trim()
    ? Number(req.query.entry) : null;
  const entryOverride = entryParam != null && Number.isFinite(entryParam) && entryParam > 0
    ? entryParam : null;

  // Canonicalize to the user's broker symbol where possible (best-effort).
  const symbol = await canonicalizeBrokerSymbol(userId, symbolRaw, symbolRaw);

  let routed;
  try {
    routed = await routeCandles(symbol, "M15", 200);
  } catch {
    res.status(200).json({
      ok: false, reason: "MARKET_DATA_UNAVAILABLE",
      userMessage: "Couldn't reach a live feed to compute a suggestion. Enter SL/TP manually.",
      ...envelope(),
    });
    return;
  }

  // Map the router's candle shape (time: ISO string) to the domain Candle
  // shape (time: epoch ms). Only OHLC is used by ATR / volatility.
  const candles: Candle[] = (routed.candles ?? []).map((c) => ({
    open: c.open, high: c.high, low: c.low, close: c.close,
    volume: c.volume,
    time: typeof c.time === "number" ? c.time : Date.parse(String(c.time)) || 0,
  }));
  // ATR(14) needs at least 15 candles to be meaningful; classifyVolatility
  // needs more for its baseline but degrades to NORMAL honestly.
  if (!routed.ok || candles.length < 15) {
    res.status(200).json({
      ok: false, reason: "INSUFFICIENT_CANDLES",
      userMessage: routed.userMessage
        ?? "Not enough recent market data to suggest SL/TP. Enter them manually.",
      ...envelope(),
    });
    return;
  }

  const atr = computeATR(candles, 14);
  const lastClose = candles[candles.length - 1].close;
  const entry = entryOverride ?? lastClose;
  if (!(Number.isFinite(atr) && atr > 0) || !(Number.isFinite(entry) && entry > 0)) {
    res.status(200).json({
      ok: false, reason: "INSUFFICIENT_CANDLES",
      userMessage: "Market volatility could not be measured. Enter SL/TP manually.",
      ...envelope(),
    });
    return;
  }

  const vol = classifyVolatility(candles);
  const slDist = atr * 1.5;
  const tpDist = slDist * 2; // 2:1 reward:risk
  // Prefer the broker's reported tick precision (EA truth) so rounding matches
  // the instrument exactly; fall back to the price-magnitude heuristic only
  // when the EA has not reported a point/tick size for this symbol yet.
  const brokerSpec = await getBrokerSymbolSpec(userId, symbol);
  const specPoint = brokerSpec.spec.point;
  const decimals = (specPoint != null && specPoint > 0)
    ? Math.max(0, Math.min(8, Math.round(-Math.log10(specPoint))))
    : inferDecimals(entry);
  const suggestedStopLoss = roundTo(side === "BUY" ? entry - slDist : entry + slDist, decimals);
  const suggestedTakeProfit = roundTo(side === "BUY" ? entry + tpDist : entry - tpDist, decimals);

  res.json({
    ok: true,
    symbol,
    side,
    entry: roundTo(entry, decimals),
    entrySource: entryOverride != null ? "provided" : "last_close",
    atr: roundTo(atr, decimals),
    atrPct: Math.round(vol.atrPct * 100) / 100,
    volatilityState: vol.state,
    riskReward: 2,
    suggestedStopLoss,
    suggestedTakeProfit,
    method: "ATR(14) · M15 · SL 1.5×ATR · TP 2R",
    note: `Suggested from current ${vol.state.toLowerCase()} volatility (ATR ${roundTo(atr, decimals)}). Editable — advisory only.`,
    ...envelope(),
  });
});

// ── Execution Cost & Survivability preview (Task #196) ──────────────────────
//
// GET /api/trades/live-shared/execution-preview
//
// Returns the honest pre-trade execution economics for a configured order:
// spread cost, lot-scaled slippage, expected fill range, starting drawdown,
// break-even, TP/SL & R:R after cost, survivability, account impact, an
// order-type recommendation, multi-entry exposure + scaling, and a
// broker-condition downgrade/block.
//
// SAFETY: purely advisory + READ-ONLY. It places NO order, queues NOTHING for
// the EA, touches NO safety surface, and is never an execution gate. Numbers
// are spec-derived (broker truth where reported) or the same standard contract
// model the live sizer uses; degraded inputs are reported honestly. Per-user
// isolation: every read is scoped to req.authUser.
router.get("/trades/live-shared/execution-preview", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }

  const symbolRaw = typeof req.query.symbol === "string" ? req.query.symbol.trim() : "";
  const sideRaw = typeof req.query.side === "string" ? req.query.side.trim().toUpperCase() : "";
  const orderTypeRaw = typeof req.query.orderType === "string"
    ? req.query.orderType.trim().toUpperCase() : "MARKET";
  if (!symbolRaw) { res.status(400).json({ ok: false, error: "MISSING_SYMBOL", ...envelope() }); return; }
  if (sideRaw !== "BUY" && sideRaw !== "SELL") {
    res.status(400).json({ ok: false, error: "INVALID_SIDE", ...envelope() }); return;
  }
  if (orderTypeRaw !== "MARKET" && orderTypeRaw !== "LIMIT" && orderTypeRaw !== "STOP") {
    res.status(400).json({ ok: false, error: "INVALID_ORDER_TYPE", ...envelope() }); return;
  }
  const side = sideRaw as ExecutionPreviewSide;
  const orderType = orderTypeRaw as ExecutionOrderType;

  const numParam = (key: string): number | null => {
    const v = req.query[key];
    if (typeof v !== "string" || !v.trim()) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const lotsParam = numParam("lots");
  const lots = lotsParam != null && lotsParam > 0 ? lotsParam : 0.01;
  const entry = numParam("entry");
  const stopLoss = numParam("stopLoss");
  const takeProfit = numParam("takeProfit");
  const maxSpreadParam = numParam("maxSpreadPoints");
  const maxSpreadPoints = maxSpreadParam != null && maxSpreadParam > 0 ? maxSpreadParam : 300;

  // Canonicalize to the user's broker symbol where possible (best-effort).
  const symbol = await canonicalizeBrokerSymbol(userId, symbolRaw, symbolRaw);

  // Per-user input gathering + estimate live in the shared service (single
  // source of truth, also used by the Smart Chart execution-cost overlay).
  const preview = await buildExecutionPreviewForUser(userId, {
    symbol,
    side,
    orderType,
    entry,
    stopLoss,
    takeProfit,
    lots,
    maxSpreadPoints,
  });

  res.json({ ok: true, preview, ...envelope() });
});

export default router;
