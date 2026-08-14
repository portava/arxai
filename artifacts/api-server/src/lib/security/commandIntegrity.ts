// ═══════════════════════════════════════════════════════════════════════════
// security/commandIntegrity.ts (api-server) — composes the REAL signals for
// command-integrity protection and runs the pure domain evaluator (AACI
// Security Phase 3: Command Integrity & Live Execution Protection).
//
// The pure verdict (lib/domain/src/security/commandIntegrity.ts) is
// deterministic and IO-free. This server wrapper is the only place that:
//   - holds the signing key (derived, key-separated, from SESSION_SECRET),
//   - stamps the integrity envelope onto a live command at DRAFT time, and
//   - re-verifies it at DISPATCH (recompute + decision lookup + route check),
//     recording a redacted security event and firing an admin alert on tamper.
//
// SAFETY (inviolable):
//   - ADVISORY-ADDITIVE ONLY. A PASS never enables anything; the 16-gate Phase B
//     pipeline, Risk Governor, kill switch, and per-user approval all still run
//     downstream. A FAIL only ADDS a block (verification runs BEFORE the gate).
//   - DEFAULT-DENY. A legacy/unstamped command (NULL payload hash) and any
//     thrown error verify as a FAIL — never silently assumed intact.
//   - node:crypto only. The raw SESSION_SECRET never enters a hash directly and
//     is never logged; the HMAC key is a separate derived value.
//   - Per-user isolation: only the command's own row + its own linked decision
//     are consulted; no cross-user data is read or returned.
// ═══════════════════════════════════════════════════════════════════════════

import { createHash } from "node:crypto";
import { db, arxLiveCommandsTable, selfTradeDecisionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  COMMAND_INTEGRITY_KEY_VERSION,
  computeIntegrityHash,
  computePayloadHash,
  evaluateCommandIntegrity,
  isCommandActorType,
  TAMPER_REASONS,
  type CommandActorType,
  type CommandIntegrityStatus,
  type CommandIntegrityVerdict,
} from "@workspace/domain/security";
import { recordSecurityEvent } from "./events.js";
import { scrub } from "./redact.js";
import { listAdminUserIds } from "../joinRequests/notifyAdmins.js";
import { createNotification } from "../notificationService.js";
import { logger } from "../logger.js";

// Approval freshness window — a command confirmed (LIVE_APPROVED) longer ago
// than this is too stale to dispatch and must be re-submitted. Generous on
// purpose: the legitimate confirm→dispatch hop is effectively immediate, so this
// only catches an approved command that sat unused. Benign (not a tamper).
const APPROVAL_FRESHNESS_SECONDS = 600;

// Allowed command sources/routes (prefix allowlist). Every server path that
// creates a live command stamps one of these; a row whose source is outside the
// allowlist could only arise from direct row tampering → INTEGRITY_ROUTE_NOT_ALLOWED.
const ALLOWED_SOURCE_PREFIXES: readonly string[] = [
  "INSTANT_", // Global Instant Trade Router: place / modify / close (chart, scanner, …)
  "LIVE_TRADE_TICKET", // Live shared trade ticket (createLiveDraft default)
  "LIVE_POSITIONS_", // Open Live Positions: CLOSE / CLOSE_ALL / MODIFY
  "LIVE_POSITION_OPS", // createLiveOpsDraft default
  "CONTROLLED_LIVE_TEST", // MT5 Setup → Controlled Live Test
  "LIVE_TEST_CYCLE", // Live Test Cycle (bare dispatch)
  "LIVE_TEST_CYCLE_", // Live Test Cycle suffixed: PREVIEW / AUTO_CLOSE
  "TRADES_LIVE_SHARED_", // Shared-live trades page: EXECUTE / CLOSE / MODIFY / VALIDATE
  "ONE_CLICK", // One-click live submit (meOneClick.ts default)
  "ADMIN_EMERGENCY_CLOSE", // Operator emergency close (runEmergencyClose → createLiveOpsDraft)
  "ADMIN_ORPHAN_CLOSE", // Operator orphan close (runEmergencyClose → createLiveOpsDraft)
] as const;

export function isRouteAllowed(sourcePage: string | null | undefined): boolean {
  if (!sourcePage) return false;
  return ALLOWED_SOURCE_PREFIXES.some((p) =>
    p.endsWith("_") ? sourcePage.startsWith(p) : sourcePage === p,
  );
}

/** Map a live command type to its stable sensitive-action class. */
export function actionTypeForCommand(commandType: string): string {
  switch (commandType) {
    case "PLACE_LIVE_MARKET_ORDER":
    case "PLACE_LIVE_PENDING_ORDER":
      return "LIVE_TRADE_EXECUTION";
    case "CLOSE_LIVE_POSITION":
      return "CLOSE_POSITION";
    case "MODIFY_LIVE_SLTP":
      return "MODIFY_SL_TP";
    default:
      return "LIVE_COMMAND";
  }
}

/**
 * Derive the integrity signing key from SESSION_SECRET with domain separation.
 * The raw secret is NEVER hashed/HMAC'd directly and NEVER logged — we hash it
 * with a fixed label so the integrity key can never be reversed into, or reused
 * as, the session secret. Returns null when no secret is configured, which puts
 * the pipeline into CREATED (payload-hash-only) placeholder mode.
 */
function getIntegrityKey(): Buffer | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.trim().length === 0) return null;
  return createHash("sha256")
    .update(`arx-live-command-integrity::v${COMMAND_INTEGRITY_KEY_VERSION}::`)
    .update(secret)
    .digest();
}

// ── Stamp (at draft) ────────────────────────────────────────────────────────

export interface BuildIntegrityFieldsInput {
  commandId: string;
  userId: number;
  commandType: string;
  symbol: string;
  side: string;
  orderType: string;
  requestedVolume: number;
  stopLoss: number | null;
  takeProfit: number | null;
  /** The full payload object being persisted on the row (hashed wholesale). */
  payload: Record<string, unknown> | null;
  actorId: number | null;
  actorType: CommandActorType;
}

export interface CommandIntegrityFields {
  payloadHash: string;
  integrityHash: string | null;
  integrityKeyVersion: number;
  integrityStatus: CommandIntegrityStatus;
  actorId: number | null;
  actorType: CommandActorType;
  actionType: string;
}

/**
 * Build the integrity columns to persist in the SAME insert as the command.
 * Always computes the payload hash; adds the HMAC signature when a signing key
 * is available (ACTIVE), otherwise records a CREATED placeholder (key version 0).
 */
export function buildCommandIntegrityFields(input: BuildIntegrityFieldsInput): CommandIntegrityFields {
  const actionType = actionTypeForCommand(input.commandType);
  const payloadHash = computePayloadHash({
    commandType: input.commandType,
    symbol: input.symbol,
    side: input.side,
    orderType: input.orderType,
    requestedVolume: input.requestedVolume,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    meaningfulPayload: input.payload,
  });

  const key = getIntegrityKey();
  if (!key) {
    return {
      payloadHash,
      integrityHash: null,
      integrityKeyVersion: 0,
      integrityStatus: "CREATED",
      actorId: input.actorId,
      actorType: input.actorType,
      actionType,
    };
  }

  const integrityHash = computeIntegrityHash(
    {
      commandId: input.commandId,
      userId: input.userId,
      actorId: input.actorId,
      actorType: input.actorType,
      actionType,
      payloadHash,
      keyVersion: COMMAND_INTEGRITY_KEY_VERSION,
    },
    key,
  );

  return {
    payloadHash,
    integrityHash,
    integrityKeyVersion: COMMAND_INTEGRITY_KEY_VERSION,
    integrityStatus: "ACTIVE",
    actorId: input.actorId,
    actorType: input.actorType,
    actionType,
  };
}

// ── Verify (at dispatch, BEFORE the 16-gate) ────────────────────────────────

/** The subset of an arx_live_commands row the verifier reads. */
export interface IntegrityVerifiableRow {
  commandId: string;
  userId: number;
  commandType: string;
  symbol: string;
  side: string;
  orderType: string;
  requestedVolume: number | string;
  stopLoss: number | string | null;
  takeProfit: number | string | null;
  payload: unknown;
  sourcePage: string | null;
  confirmedAt: Date | string | null;
  createdAt: Date | string | null;
  payloadHash: string | null;
  integrityHash: string | null;
  integrityKeyVersion: number | null;
  integrityStatus: string | null;
  actorId: number | null;
  actorType: string | null;
  actionType: string | null;
  selfTradeDecisionId: number | null;
}

function toNum(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve the AACI/self-trade decision-match check.
 *  - null  ⇒ no decision linked (manual trade — N/A, the user's confirm is the
 *            authorization).
 *  - true  ⇒ a decision is linked and its symbol matches the command.
 *  - false ⇒ a decision is linked but is missing or its symbol differs (block).
 */
async function resolveDecisionMatch(row: IntegrityVerifiableRow): Promise<boolean | null> {
  if (row.selfTradeDecisionId == null) return null;
  const [decision] = await db
    .select({ symbol: selfTradeDecisionsTable.symbol })
    .from(selfTradeDecisionsTable)
    .where(eq(selfTradeDecisionsTable.id, row.selfTradeDecisionId))
    .limit(1);
  if (!decision) return false; // stamped decision id must resolve — fail closed.
  return String(decision.symbol).toUpperCase() === String(row.symbol).toUpperCase();
}

export interface VerifyIntegrityResult {
  ok: boolean;
  verdict: CommandIntegrityVerdict;
}

/**
 * Verify a command's integrity immediately before the 16-gate dispatch
 * evaluation. Never throws — any internal error default-denies. On a tamper
 * verdict it records a redacted HIGH security event and notifies admins
 * (best-effort; alerting failure never changes the verdict).
 */
export async function verifyCommandIntegrityForDispatch(
  row: IntegrityVerifiableRow,
): Promise<VerifyIntegrityResult> {
  let verdict: CommandIntegrityVerdict;
  try {
    const recomputedPayloadHash = computePayloadHash({
      commandType: row.commandType,
      symbol: row.symbol,
      side: row.side,
      orderType: row.orderType,
      requestedVolume: toNum(row.requestedVolume) ?? NaN,
      stopLoss: toNum(row.stopLoss),
      takeProfit: toNum(row.takeProfit),
      meaningfulPayload: (row.payload as Record<string, unknown> | null) ?? null,
    });

    const signed = row.integrityStatus === "ACTIVE" && (row.integrityKeyVersion ?? 0) >= 1;
    const actorValid = row.actorId != null && isCommandActorType(row.actorType);

    let recomputedIntegrityHash: string | null = null;
    if (signed) {
      const key = getIntegrityKey();
      // Recompute the signature over the CURRENT envelope fields + the STORED
      // payload hash (the value that was signed). Any tamper of the envelope
      // fields OR the stored payload hash changes this and trips a mismatch.
      if (key && actorValid && row.payloadHash) {
        recomputedIntegrityHash = computeIntegrityHash(
          {
            commandId: row.commandId,
            userId: row.userId,
            actorId: row.actorId,
            actorType: row.actorType as CommandActorType,
            actionType: row.actionType ?? actionTypeForCommand(row.commandType),
            payloadHash: row.payloadHash,
            keyVersion: row.integrityKeyVersion ?? COMMAND_INTEGRITY_KEY_VERSION,
          },
          key,
        );
      }
    }

    const confirmedAt = toDate(row.confirmedAt) ?? toDate(row.createdAt);
    const fresh =
      confirmedAt != null &&
      Date.now() - confirmedAt.getTime() <= APPROVAL_FRESHNESS_SECONDS * 1000;

    const decisionMatch = await resolveDecisionMatch(row);

    verdict = evaluateCommandIntegrity({
      storedPayloadHash: row.payloadHash,
      recomputedPayloadHash,
      signed,
      storedIntegrityHash: row.integrityHash,
      recomputedIntegrityHash,
      routeAllowed: isRouteAllowed(row.sourcePage),
      actorValid,
      decisionMatch,
      fresh,
    });
  } catch (err) {
    // DEFAULT-DENY — an unverifiable command must not dispatch.
    verdict = evaluateCommandIntegrity({
      storedPayloadHash: null,
      recomputedPayloadHash: "",
      signed: false,
      storedIntegrityHash: null,
      recomputedIntegrityHash: null,
      routeAllowed: false,
      actorValid: false,
      decisionMatch: false,
      fresh: false,
    });
    logger.warn({ err, commandId: row.commandId }, "security: command integrity verify failed (default-deny)");
  }

  if (!verdict.ok) {
    await recordIntegrityFailure(row, verdict);
  }
  return { ok: verdict.ok, verdict };
}

// ── Replay (double-dispatch of a non-APPROVED command) ──────────────────────

/**
 * Record a redacted security event + admin alert for a replay / double-dispatch
 * attempt (a dispatch called on a command that is not LIVE_APPROVED — e.g.
 * already SENT_TO_MT5_LIVE, FILLED, or terminal). Best-effort; never throws.
 */
export async function recordLiveCommandReplayAttempt(args: {
  userId: number;
  commandId: string;
  currentStatus: string;
}): Promise<void> {
  await fireSecurityAndAlert({
    eventType: "LIVE_COMMAND_REPLAY_BLOCKED",
    severity: "HIGH",
    userId: args.userId,
    permissionKey: "live:command:replay",
    adminMessage: `Live command replay blocked: dispatch attempted on non-approved command (status=${args.currentStatus}).`,
    notifyTitle: "Live command replay blocked",
    metadata: { commandId: args.commandId, currentStatus: args.currentStatus, userId: args.userId },
  });
}

/**
 * Record a redacted security event + admin alert for a duplicate command blocked
 * by the idempotency guard. Best-effort; never throws.
 */
export async function recordLiveCommandDuplicateBlocked(args: {
  userId: number;
  commandId: string;
}): Promise<void> {
  await fireSecurityAndAlert({
    eventType: "LIVE_COMMAND_DUPLICATE_BLOCKED",
    severity: "WARNING",
    userId: args.userId,
    permissionKey: "live:command:duplicate",
    adminMessage: "Duplicate command blocked by idempotency guard.",
    notifyTitle: "Duplicate live command blocked",
    metadata: { commandId: args.commandId, userId: args.userId },
  });
}

/** User-facing copy for the idempotency-duplicate block. */
export const DUPLICATE_LIVE_COMMAND_USER_MESSAGE = "This trade request is already being processed.";

// ── Internals ───────────────────────────────────────────────────────────────

async function recordIntegrityFailure(
  row: IntegrityVerifiableRow,
  verdict: CommandIntegrityVerdict,
): Promise<void> {
  // Tamper/forgery → HIGH + admin alert. Benign staleness (expired) → a WARNING
  // event only, no admin alert.
  if (verdict.tamper && TAMPER_REASONS.has(verdict.reason)) {
    await fireSecurityAndAlert({
      eventType: "LIVE_COMMAND_INTEGRITY_VIOLATION",
      severity: "HIGH",
      userId: row.userId,
      permissionKey: `integrity:${verdict.reason.toLowerCase()}`,
      adminMessage: verdict.adminMessage,
      notifyTitle: "Live command integrity violation",
      metadata: {
        commandId: row.commandId,
        reason: verdict.reason,
        actorType: row.actorType,
        sourcePage: row.sourcePage,
        userId: row.userId,
      },
    });
    return;
  }
  try {
    await recordSecurityEvent({
      eventType: "LIVE_COMMAND_INTEGRITY_STALE",
      severity: "WARNING",
      status: "DENIED",
      actorUserId: row.userId,
      permissionKey: `integrity:${verdict.reason.toLowerCase()}`,
      message: verdict.adminMessage,
      metadata: scrub({ commandId: row.commandId, reason: verdict.reason, userId: row.userId }) as Record<string, unknown>,
    });
  } catch (err) {
    logger.warn({ err, commandId: row.commandId }, "security: integrity stale event record failed (non-fatal)");
  }
}

async function fireSecurityAndAlert(args: {
  eventType: string;
  severity: "WARNING" | "HIGH" | "CRITICAL";
  userId: number;
  permissionKey: string;
  adminMessage: string;
  notifyTitle: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  try {
    await recordSecurityEvent({
      eventType: args.eventType,
      severity: args.severity,
      status: "DENIED",
      actorUserId: args.userId,
      permissionKey: args.permissionKey,
      message: args.adminMessage,
      metadata: scrub(args.metadata) as Record<string, unknown>,
    });
  } catch (err) {
    logger.warn({ err, eventType: args.eventType }, "security: integrity event record failed (non-fatal)");
  }
  try {
    const adminIds = await listAdminUserIds();
    await Promise.all(
      adminIds.map((adminId) =>
        createNotification(adminId, {
          notificationType: args.eventType,
          severity: args.severity === "HIGH" || args.severity === "CRITICAL" ? "critical" : "warning",
          source: "security",
          title: args.notifyTitle,
          message: args.adminMessage,
        }),
      ),
    );
  } catch (err) {
    logger.warn({ err, eventType: args.eventType }, "security: integrity admin notify failed (non-fatal)");
  }
}
