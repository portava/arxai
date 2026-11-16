// ═══════════════════════════════════════════════════════════════════════════
// Shadow adapter — the safe parallel-audit gateway.
//
// Wraps an EventStorePort + chain seal. In SHADOW_MODE every captureEvent()
// call records to the vault but NEVER throws to the caller; failures are
// returned as { ok: false, error }. The host app keeps running normally.
//
// In ACTIVE_MODE (future, after promotion) failures are still returned in
// the same shape; the host app may choose to escalate. Promotion logic is
// left to the host — this engine never decides to flip itself.
//
// The vault cannot:
//   - place trades
//   - approve trades
//   - override Risk Governor
//   - override Control Tower
// It only RECORDS.
// ═══════════════════════════════════════════════════════════════════════════

import type { AuditEventDraft, VaultMode } from "./eventSchema.types.js";
import { recordEvent, type AuditTrailDeps, type AuditTrailWriteResult } from "./auditTrail.engine.js";

export interface ShadowAdapter {
  mode: VaultMode;
  capture(draft: AuditEventDraft): Promise<AuditTrailWriteResult>;
  /** Read-only health probe — pings the store with a no-op count(). */
  isStorageAvailable(): Promise<boolean>;
}

export interface ShadowAdapterDeps extends AuditTrailDeps {
  mode?: VaultMode;
  /** Optional sink for shadow-mode write failures (logger). */
  onFailure?: (err: string, draft: AuditEventDraft) => void;
}

export function createShadowAdapter(deps: ShadowAdapterDeps): ShadowAdapter {
  const mode: VaultMode = deps.mode ?? "SHADOW_MODE";
  return {
    mode,
    async capture(draft) {
      const result = await recordEvent(draft, deps);
      if (!result.ok) {
        // Shadow mode: never propagate. Just notify so the host can degrade.
        deps.onFailure?.(result.error ?? "unknown", draft);
      }
      return result;
    },
    async isStorageAvailable() {
      try {
        await deps.store.count();
        return true;
      } catch {
        return false;
      }
    },
  };
}
