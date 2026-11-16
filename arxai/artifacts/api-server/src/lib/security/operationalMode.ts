// ═══════════════════════════════════════════════════════════════════════════
// Phase 7 — security operational-mode service (get / set, audited).
//
// Persists the explicit NORMAL | LOCKDOWN | INCIDENT switch on the singleton
// `security_settings` row and resolves the PURE domain posture from it. The
// posture is applied at chokepoints (self-trade entry, allocation, autonomy).
//
// SAFETY:
//  - An unknown/unparseable stored mode resolves to the SAFEST posture
//    (INCIDENT) via the domain resolver — never to NORMAL.
//  - Every mode change writes a tamper-evident CRITICAL audit event. The change
//    can only ADD caution; it never relaxes an existing trade/auth gate.
// ═══════════════════════════════════════════════════════════════════════════

import { db, securitySettingsTable } from "@workspace/db";
import {
  isSecurityOperationalMode,
  resolveOperationalModePosture,
  type OperationalModePosture,
  type SecurityOperationalMode,
} from "@workspace/domain/security";
import { getSettings } from "./settings.js";
import { mirrorCriticalEvent } from "./events.js";

export interface OperationalModeState {
  mode: SecurityOperationalMode;
  reason: string | null;
  changedAt: string | null;
  changedBy: number | null;
  posture: OperationalModePosture;
}

export async function getOperationalMode(): Promise<OperationalModeState> {
  const settings = await getSettings();
  const stored = settings.operationalMode;
  // Resolver is the source of truth for safety: unknown ⇒ INCIDENT posture.
  const posture = resolveOperationalModePosture(stored);
  return {
    mode: posture.mode,
    reason: settings.operationalModeReason ?? null,
    changedAt: settings.operationalModeChangedAt ? settings.operationalModeChangedAt.toISOString() : null,
    changedBy: settings.operationalModeChangedBy ?? null,
    posture,
  };
}

export interface SetOperationalModeInput {
  mode: string;
  reason: string;
  changedBy: number;
  actorRole?: string | null;
}

export interface SetOperationalModeResult {
  ok: boolean;
  rejected?: "INVALID_MODE" | "REASON_REQUIRED";
  state: OperationalModeState;
}

export async function setOperationalMode(input: SetOperationalModeInput): Promise<SetOperationalModeResult> {
  if (!isSecurityOperationalMode(input.mode)) {
    return { ok: false, rejected: "INVALID_MODE", state: await getOperationalMode() };
  }
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 3) {
    return { ok: false, rejected: "REASON_REQUIRED", state: await getOperationalMode() };
  }

  const now = new Date();
  await db.update(securitySettingsTable).set({
    operationalMode: input.mode,
    operationalModeReason: reason,
    operationalModeChangedAt: now,
    operationalModeChangedBy: input.changedBy,
    updatedAt: now,
  });

  // Tamper-evident, hash-chained record of the mode change (best-effort).
  await mirrorCriticalEvent({
    eventType: "LOCKDOWN_MODE",
    severity: input.mode === "NORMAL" ? "WARNING" : "CRITICAL",
    status: "TRIGGERED",
    actorUserId: input.changedBy,
    actorRole: input.actorRole ?? null,
    actorType: input.actorRole ?? null,
    affectedObject: "security_settings:operational_mode",
    message: `Security operational mode set to ${input.mode}`,
    metadata: { mode: input.mode, reason },
  });

  return { ok: true, state: await getOperationalMode() };
}
