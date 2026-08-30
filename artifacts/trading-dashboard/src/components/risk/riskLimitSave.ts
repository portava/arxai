// RANK 16 (high) — raising a risk limit said "Saved ✓" and was not saved.
//
// THE DEFECT
//   PATCH /api/risk/settings has an asymmetric contract (routes/risk.ts +
//   lib/riskVault/delayedIncrease.ts): a field that TIGHTENS risk applies
//   immediately, a field that LOOSENS it is queued behind a 24-hour waiting
//   period and must be confirmed again afterwards. The response says exactly
//   which happened:
//
//       { ...settings, appliedNow: string[], pendingIncreases: [...],
//         classifications: {...}, increaseDelayMs: number,
//         queueFailure: string | null }
//
//   A repo-wide grep across the dashboard for `pendingIncreases`, `appliedNow`,
//   `queueFailure` or `pending-increases` returned ZERO hits. Both UIs threw
//   the whole response away and toasted "Saved ✓" / "Risk parameters updated"
//   unconditionally — and settings.tsx used an UNCONTROLLED `defaultValue`, so
//   the number the user typed stayed on screen looking authoritative.
//
//   Net effect: a user raised Max Daily Loss % or Risk Per Trade, saw green
//   confirmation, and believed the looser limit was in force. It was not, and —
//   because no screen in the app could confirm a pending increase — it never
//   would be. If `queueFailure` was set, the increase was dropped entirely and
//   the UI still said Saved.
//
// THIS MODULE
//   The typed response plus a pure classifier that turns it into per-field,
//   plain-English outcomes. Pure so it can be tested without a server; used by
//   both the Settings → Risk tab and /risk-settings so the two cannot drift.
//
// The governing rule this restores: a surface may never claim more than the
// code delivers, and AUTO authority may only REDUCE. A queued increase is NOT
// an applied increase and must never be drawn as one.

export interface PendingIncrease {
  id: number;
  field: string;
  currentValue: number;
  targetValue: number;
  effectiveAt: string;
  status: string;
  /** Present on GET /risk/pending-increases; absent on the PATCH echo. */
  confirmableNow?: boolean;
  remainingMs?: number;
  valueKind?: string;
  requestedAt?: string;
}

export interface RiskSettingsPatchResponse {
  /** Fields written to the row immediately (tightenings). */
  appliedNow?: string[];
  /** Loosenings parked behind the waiting period. */
  pendingIncreases?: PendingIncrease[];
  /** Milliseconds a queued increase must wait before it can be confirmed. */
  increaseDelayMs?: number;
  /**
   * Set when the pending-increase store was unavailable: the requested
   * increase was NOT queued and will NOT apply. Increases fail closed.
   */
  queueFailure?: string | null;
  [k: string]: unknown;
}

export type FieldOutcomeKind = "applied" | "queued" | "dropped" | "unchanged";

export interface FieldOutcome {
  field: string;
  kind: FieldOutcomeKind;
  /** One sentence stating what actually happened to this field. */
  message: string;
  /** For "queued": when the increase can be confirmed. */
  effectiveAt?: string;
}

function hoursFromNow(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 3_600_000));
}

/**
 * Turn one PATCH response into a per-field verdict for the fields that were
 * actually submitted. Never reports success for a field the server did not say
 * it applied.
 */
export function classifyRiskSave(
  submittedFields: string[],
  res: RiskSettingsPatchResponse,
): FieldOutcome[] {
  const applied = new Set(res.appliedNow ?? []);
  const queued = new Map((res.pendingIncreases ?? []).map((p) => [p.field, p]));
  return submittedFields.map((field): FieldOutcome => {
    if (applied.has(field)) {
      return { field, kind: "applied", message: "Applied now." };
    }
    const q = queued.get(field);
    if (q) {
      const hrs = hoursFromNow(q.effectiveAt);
      return {
        field,
        kind: "queued",
        effectiveAt: q.effectiveAt,
        message:
          `Queued — this raises your limit, so it does NOT apply yet. ` +
          `Confirmable in ${hrs}h (${new Date(q.effectiveAt).toLocaleString()}). ` +
          `Until you confirm it, your previous, tighter limit stays in force.`,
      };
    }
    if (res.queueFailure) {
      return {
        field,
        kind: "dropped",
        message: `NOT saved. ${res.queueFailure}`,
      };
    }
    // Submitted, not applied, not queued, no failure reported: the server
    // considered it a no-op. Say that rather than implying a change.
    return { field, kind: "unchanged", message: "No change — the value was already in force." };
  });
}

/** True when nothing the user submitted actually took effect. */
export function nothingApplied(outcomes: FieldOutcome[]): boolean {
  return outcomes.length > 0 && outcomes.every((o) => o.kind !== "applied");
}

/** The single headline for a save, honest about the mixed case. */
export function saveHeadline(outcomes: FieldOutcome[]): { title: string; tone: "ok" | "warn" | "error" } {
  if (outcomes.some((o) => o.kind === "dropped")) {
    return { title: "Not saved — the change was dropped", tone: "error" };
  }
  const queued = outcomes.filter((o) => o.kind === "queued").length;
  const applied = outcomes.filter((o) => o.kind === "applied").length;
  if (queued > 0 && applied > 0) return { title: `${applied} applied, ${queued} queued for confirmation`, tone: "warn" };
  if (queued > 0) return { title: `Queued — not in force yet`, tone: "warn" };
  if (applied > 0) return { title: "Applied", tone: "ok" };
  return { title: "No change", tone: "ok" };
}
