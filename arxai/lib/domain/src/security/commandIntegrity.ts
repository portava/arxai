// ═══════════════════════════════════════════════════════════════════════════
// security/commandIntegrity.ts — pure command-integrity primitives + evaluator
// (AACI Security Phase 3: Command Integrity & Live Execution Protection).
//
// Deterministic, IO-free. The api-server stamps an integrity envelope on every
// live command at draft time and re-verifies it at dispatch, BEFORE the 16-gate
// Phase B evaluator. This module owns the canonicalization, the hashing
// (node:crypto only), and the pure verdict; the server wrapper owns the secret,
// the DB decision lookup, and the admin alerting.
//
// SAFETY (inviolable):
//  - ADVISORY-ADDITIVE ONLY. A PASS verdict never enables anything — the 16-gate
//    Phase B pipeline, Risk Governor, kill switch, and per-user approval still
//    run and can still refuse. A FAIL verdict only ADDS a block.
//  - DEFAULT-DENY on the unverifiable. A missing stored payload hash, a missing
//    recomputed hash, or an unrecognised source is treated as FAIL — never
//    silently assumed intact.
//  - Canonicalization is stable and lossless for the trade-critical fields. Two
//    semantically-identical orders always hash identically; any change to a
//    trade-critical parameter changes the hash.
//  - No secret ever enters this module. The HMAC key is supplied by the caller.
// ═══════════════════════════════════════════════════════════════════════════

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Current integrity signing key generation. Bumped only on key rotation. */
export const COMMAND_INTEGRITY_KEY_VERSION = 1 as const;

/**
 * Integrity lifecycle status persisted on the command row.
 *  - ACTIVE   ⇒ stamped with a real HMAC signature (signing key available).
 *  - CREATED  ⇒ payload-hash-only placeholder (no signing key configured).
 *  - TAMPERED ⇒ set at dispatch when verification detected a tamper/forgery.
 */
export type CommandIntegrityStatus = "ACTIVE" | "CREATED" | "TAMPERED";

/** The principal class that authored a sensitive command (source validation). */
export type CommandActorType =
  | "USER"
  | "ADMIN"
  | "OWNER"
  | "SELF_TRADE_AGENT"
  | "SYSTEM";

export const COMMAND_ACTOR_TYPES: readonly CommandActorType[] = [
  "USER",
  "ADMIN",
  "OWNER",
  "SELF_TRADE_AGENT",
  "SYSTEM",
] as const;

export function isCommandActorType(value: unknown): value is CommandActorType {
  return typeof value === "string" && (COMMAND_ACTOR_TYPES as readonly string[]).includes(value);
}

/**
 * Trade-critical parameters that define WHAT a command does. Any change to any
 * of these between confirm and dispatch is a tamper. `meaningfulPayload` carries
 * the small set of payload keys that change execution semantics (referencePrice,
 * brokerTicket, allowNoStopLossThisDraft, agentOwnership) — never volatile or
 * client-echoed noise.
 */
export interface CanonicalCommandParams {
  commandType: string;
  symbol: string;
  side: string;
  orderType: string;
  requestedVolume: number;
  stopLoss: number | null;
  takeProfit: number | null;
  meaningfulPayload?: Record<string, unknown> | null;
}

/** The envelope bound into the integrity signature. */
export interface CommandIntegrityEnvelope {
  commandId: string;
  userId: number;
  actorId: number | null;
  actorType: CommandActorType | null;
  actionType: string;
  payloadHash: string;
  keyVersion: number;
}

// ── Canonicalization ────────────────────────────────────────────────────────

/**
 * Stable JSON of an arbitrary value: object keys are emitted in sorted order at
 * every depth so two semantically-equal objects serialize identically. Numbers,
 * strings, booleans, null, arrays, and plain objects only — functions/undefined
 * are dropped (they never appear in trade params).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  // undefined / function / symbol — never part of trade params.
  return "null";
}

/**
 * Normalise numeric fields with fixed precision so 1.0 and 1 hash identically
 * and float jitter cannot bypass the comparison. Lots at 4dp (matches the
 * idempotency key), prices at 5dp.
 */
function normVolume(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : "NaN";
}
function normPrice(n: number | null): string {
  return n != null && Number.isFinite(n) ? n.toFixed(5) : "_";
}

/** Build the canonical string for the trade-critical parameters. */
export function canonicalizeCommandParams(p: CanonicalCommandParams): string {
  return [
    `ct=${p.commandType}`,
    `sym=${p.symbol.toUpperCase()}`,
    `side=${p.side.toUpperCase()}`,
    `ot=${p.orderType.toUpperCase()}`,
    `vol=${normVolume(p.requestedVolume)}`,
    `sl=${normPrice(p.stopLoss)}`,
    `tp=${normPrice(p.takeProfit)}`,
    `pl=${p.meaningfulPayload ? stableStringify(p.meaningfulPayload) : "{}"}`,
  ].join("|");
}

/** SHA-256 hex of the canonical trade-critical parameters. */
export function computePayloadHash(p: CanonicalCommandParams): string {
  return createHash("sha256").update(canonicalizeCommandParams(p)).digest("hex");
}

/** HMAC-SHA256 hex over the integrity envelope, keyed by the server secret. */
export function computeIntegrityHash(env: CommandIntegrityEnvelope, key: Buffer | string): string {
  const canonical = [
    `cid=${env.commandId}`,
    `uid=${env.userId}`,
    `aid=${env.actorId ?? "_"}`,
    `at=${env.actorType ?? "_"}`,
    `act=${env.actionType}`,
    `ph=${env.payloadHash}`,
    `kv=${env.keyVersion}`,
  ].join("|");
  return createHmac("sha256", key).update(canonical).digest("hex");
}

/** Constant-time hex compare. Returns false on any length/format mismatch. */
export function safeHexEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let ba: Buffer;
  let bb: Buffer;
  try {
    ba = Buffer.from(a, "hex");
    bb = Buffer.from(b, "hex");
  } catch {
    return false;
  }
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ── Verdict ─────────────────────────────────────────────────────────────────

export type CommandIntegrityReason =
  | "INTEGRITY_OK"
  | "INTEGRITY_PAYLOAD_MISSING"
  | "INTEGRITY_PAYLOAD_MISMATCH"
  | "INTEGRITY_SIGNATURE_MISSING"
  | "INTEGRITY_SIGNATURE_MISMATCH"
  | "INTEGRITY_EXPIRED"
  | "INTEGRITY_ROUTE_NOT_ALLOWED"
  | "INTEGRITY_DECISION_MISMATCH"
  | "INTEGRITY_ACTOR_INVALID";

/** Failures that indicate active tampering/forgery (vs benign staleness). */
export const TAMPER_REASONS: ReadonlySet<CommandIntegrityReason> = new Set([
  "INTEGRITY_PAYLOAD_MISSING",
  "INTEGRITY_PAYLOAD_MISMATCH",
  "INTEGRITY_SIGNATURE_MISSING",
  "INTEGRITY_SIGNATURE_MISMATCH",
  "INTEGRITY_ROUTE_NOT_ALLOWED",
  "INTEGRITY_DECISION_MISMATCH",
  "INTEGRITY_ACTOR_INVALID",
]);

export interface CommandIntegrityVerdict {
  ok: boolean;
  reason: CommandIntegrityReason;
  /** True when the failure looks like tampering/forgery (drives admin alerting). */
  tamper: boolean;
  /** Constant, clean, token-free copy safe to show any user. */
  userMessage: string;
  /** Admin-facing diagnostic (names the reason key only — no secrets/values). */
  adminMessage: string;
}

const USER_TAMPER_MESSAGE = "This trade request could not be verified and was blocked for your safety.";
const USER_EXPIRED_MESSAGE = "This trade request has expired. Please review and submit it again.";
const USER_OK_MESSAGE = "Trade request verified.";

/**
 * Inputs for the pure integrity evaluation. The server wrapper recomputes the
 * hashes from the CURRENT row (post-confirm, at dispatch) and supplies the
 * stored values + the cross-checks it resolved (route allowlist, decision match,
 * actor validity, approval freshness).
 */
export interface CommandIntegrityVerifyInput {
  /** Stored hash written at draft. */
  storedPayloadHash: string | null;
  /** Hash recomputed from the current row at dispatch. */
  recomputedPayloadHash: string;
  /** Whether signing was active when the command was stamped. */
  signed: boolean;
  /** Stored signature written at draft (null in placeholder mode). */
  storedIntegrityHash: string | null;
  /** Signature recomputed from the current row at dispatch (null if no key). */
  recomputedIntegrityHash: string | null;
  /** The command's stored source/route is in the allowlist. */
  routeAllowed: boolean;
  /** Actor identity is present and valid. */
  actorValid: boolean;
  /**
   * Decision linkage check. `null` ⇒ no AACI decision was linked (manual trade —
   * the user's confirm is the authorization, N/A). `true`/`false` ⇒ a decision
   * WAS linked and it does / does not match the command.
   */
  decisionMatch: boolean | null;
  /** Approval freshness — false ⇒ confirmed too long ago to dispatch. */
  fresh: boolean;
}

function verdict(
  reason: CommandIntegrityReason,
  tamper: boolean,
  userMessage: string,
  adminMessage: string,
): CommandIntegrityVerdict {
  return { ok: reason === "INTEGRITY_OK", reason, tamper, userMessage, adminMessage };
}

/**
 * Evaluate command integrity. Default-deny: checked in tamper-first order so the
 * most security-relevant failure is surfaced. Pure — identical inputs always
 * produce identical output.
 */
export function evaluateCommandIntegrity(i: CommandIntegrityVerifyInput): CommandIntegrityVerdict {
  // 1. Payload hash must exist and match (tamper / legacy-unverified).
  if (!i.storedPayloadHash) {
    return verdict("INTEGRITY_PAYLOAD_MISSING", true, USER_TAMPER_MESSAGE, "Command has no stored payload hash (unverified/legacy).");
  }
  if (!safeHexEqual(i.storedPayloadHash, i.recomputedPayloadHash)) {
    return verdict("INTEGRITY_PAYLOAD_MISMATCH", true, USER_TAMPER_MESSAGE, "Command payload hash mismatch — order changed after approval.");
  }

  // 2. Signature (only when the command was signed at stamp time).
  if (i.signed) {
    if (!i.storedIntegrityHash) {
      return verdict("INTEGRITY_SIGNATURE_MISSING", true, USER_TAMPER_MESSAGE, "Signed command is missing its integrity signature.");
    }
    if (!i.recomputedIntegrityHash || !safeHexEqual(i.storedIntegrityHash, i.recomputedIntegrityHash)) {
      return verdict("INTEGRITY_SIGNATURE_MISMATCH", true, USER_TAMPER_MESSAGE, "Command integrity signature mismatch — envelope tampered or re-keyed.");
    }
  }

  // 3. Actor identity present + valid (source validation).
  if (!i.actorValid) {
    return verdict("INTEGRITY_ACTOR_INVALID", true, USER_TAMPER_MESSAGE, "Command actor identity is missing or invalid.");
  }

  // 4. Source/route allowlist.
  if (!i.routeAllowed) {
    return verdict("INTEGRITY_ROUTE_NOT_ALLOWED", true, USER_TAMPER_MESSAGE, "Command originated from an unrecognised route/source.");
  }

  // 5. AACI decision linkage (only when a decision was linked).
  if (i.decisionMatch === false) {
    return verdict("INTEGRITY_DECISION_MISMATCH", true, USER_TAMPER_MESSAGE, "Command does not match its linked AACI decision.");
  }

  // 6. Approval freshness (benign staleness — not a tamper).
  if (!i.fresh) {
    return verdict("INTEGRITY_EXPIRED", false, USER_EXPIRED_MESSAGE, "Command approval is too old to dispatch (stale).");
  }

  return verdict("INTEGRITY_OK", false, USER_OK_MESSAGE, "Command integrity verified.");
}
