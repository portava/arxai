// Derived safety envelope for the AI assistant (Ruby).
//
// SAFETY / HONESTY: Ruby must REPORT the user's real, per-user trading state —
// never a hardcoded "paper-only / system-locked" stub that drifts from reality.
// The canonical truth is `getEnvelope(userId)` in adminTrading/safetyEnvelope.ts
// (fail-closed in every branch). This module is the single place the assistant
// surfaces (tools, routes, voice session, system prompt) resolve that truth.
//
// This is ADVISORY / REPORTING ONLY. It authorizes nothing. Live execution is
// still gated by the order-guard chain + the 16-gate Phase B dispatch + the
// explicit per-trade user-confirmation choreography. Deriving the envelope
// changes only what Ruby *says*, never what it is *allowed to do*.

import {
  getEnvelope,
  FAIL_CLOSED_ENVELOPE,
  type SafetyEnvelope,
} from "../adminTrading/safetyEnvelope.js";
import { logger } from "../logger.js";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";

export type { SafetyEnvelope };
export { FAIL_CLOSED_ENVELOPE };

// Forced read-only envelope for Ruby's READ-ONLY chart surfaces (draft-read,
// draw-setup, chart-intelligence). These surfaces can NEVER place or manage an
// order regardless of the user's live permissions, so reporting paper_only /
// readOnly is HONEST here — and the OpenAPI contract pins safetyMode to
// enum:[paper_only] for them. This is NOT a drifting "system is paper-only"
// claim: it is the truthful state of a read surface. Conversational / status /
// CRUD surfaces must use the DERIVED per-user envelope instead.
export const READ_ONLY_PAPER_ENVELOPE = {
  safetyMode: "paper_only" as const,
  liveLocked: true as const,
  readOnlyMode: true as const,
  allowOrderExecution: false as const,
};

// The subset of the full SafetyEnvelope that assistant tool/route results
// carry. Kept stable so every Ruby surface advertises the same shape. Honest
// both ways: when the live path is open these report it; when it is locked they
// report the real top blocker — never a fabricated paper-only stub.
export interface AssistantEnvelopeFields {
  safetyMode: SafetyEnvelope["safetyMode"];
  liveLocked: boolean;
  readOnlyMode: boolean;
  allowOrderExecution: boolean;
  tradingMode: SafetyEnvelope["tradingMode"];
  bannerLabel: SafetyEnvelope["bannerLabel"];
  bannerReason: string;
  globalLiveEnabled: boolean;
  userLiveApproved: boolean;
  emergencyKillSwitch: boolean;
  accountType: SafetyEnvelope["accountType"];
}

/**
 * Resolve the per-user safety envelope for any assistant surface.
 * Fail-closed: any throw collapses to FAIL_CLOSED_ENVELOPE (off / locked),
 * never a phantom "live available".
 */
export async function deriveAssistantEnvelope(
  userId: number | null | undefined,
): Promise<SafetyEnvelope> {
  try {
    return await getEnvelope(userId);
  } catch (err) {
    logger.warn({ err: String(err), userId }, "deriveAssistantEnvelope failed; using fail-closed default");
    return FAIL_CLOSED_ENVELOPE;
  }
}

/** Project the full envelope down to the stable assistant-facing subset. */
export function assistantEnvelopeFields(env: SafetyEnvelope): AssistantEnvelopeFields {
  return {
    safetyMode: env.safetyMode,
    liveLocked: env.liveLocked,
    readOnlyMode: env.readOnlyMode,
    allowOrderExecution: env.allowOrderExecution,
    tradingMode: env.tradingMode,
    bannerLabel: env.bannerLabel,
    bannerReason: env.bannerReason,
    globalLiveEnabled: env.globalLiveEnabled,
    userLiveApproved: env.userLiveApproved,
    emergencyKillSwitch: env.emergencyKillSwitch,
    accountType: env.accountType,
  };
}

export interface PaperSafetyStatus extends AssistantEnvelopeFields {
  reason: string;
  overrideRequires: string | null;
}

/**
 * Pure, DB-free derivation of the "why does it say paper-only / can you place a
 * live trade?" answer. Honest both ways:
 *  - live path open  → live IS available, subject to per-trade confirmation + gates.
 *  - live path locked → the real top blocker (env.bannerReason), not a stale stub.
 *
 * NOTE: this intentionally no longer cites BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED —
 * the broker placement layer is enabled; the legacy literal lives only in the
 * legacy chokepoint + Phase B blockReasons where CI guards require it.
 */
export function buildPaperSafetyStatus(
  env: SafetyEnvelope,
  assistantName: string = DEFAULT_ASSISTANT_NAME,
): PaperSafetyStatus {
  const fields = assistantEnvelopeFields(env);
  if (!env.liveLocked) {
    return {
      ...fields,
      reason:
        `Live execution is available for your account (mode: ${env.bannerLabel}). ` +
        `Live orders still require your explicit per-trade confirmation and must pass ` +
        `every live safety gate at dispatch — ${assistantName} never bypasses a gate or the confirmation step.`,
      overrideRequires: null,
    };
  }
  return {
    ...fields,
    reason:
      env.bannerReason ||
      "Live trading is not enabled for this account right now; the system stays on the demo/paper path.",
    overrideRequires:
      "Live trading requires the platform live mode to be on, admin approval for your account, " +
      "an accepted risk disclosure, and a verified live broker connection — then every order still " +
      "needs your explicit confirmation and must pass all live safety gates.",
  };
}

/**
 * One-line, honest "can Ruby place a live order for you right now?" note for the
 * per-user status / CRUD assistant surfaces (MT5 bridge status, pre-trade risk
 * check, capability status). DERIVED per-user and honest BOTH ways — never a
 * hardcoded "system-locked / paper-only" claim:
 *  - live path open  → live IS available, subject to per-trade confirmation + every gate.
 *  - live path locked → the real top blocker (env.bannerReason).
 * Reporting only; it authorizes nothing. Accepts the full SafetyEnvelope or the
 * projected AssistantEnvelopeFields (both carry these four fields).
 */
export function liveExecutionAvailabilityNote(
  env: Pick<SafetyEnvelope, "liveLocked" | "allowOrderExecution" | "bannerLabel" | "bannerReason">,
  assistantName: string = DEFAULT_ASSISTANT_NAME,
): string {
  if (!env.liveLocked && env.allowOrderExecution) {
    return (
      `Live order execution is available for your account (mode: ${env.bannerLabel}). ` +
      `Every live order still requires your explicit per-trade confirmation and must pass ` +
      `all live safety gates at dispatch — ${assistantName} never bypasses a gate or the confirmation step.`
    );
  }
  return (
    env.bannerReason ||
    "Live order execution is not available for your account right now; the system stays on the demo/paper path."
  );
}
