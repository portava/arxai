// Task #32 — EA update gate (pure, server + dashboard shared).
//
// Decides whether an EA may apply an available update RIGHT NOW. The gate is a
// pure function so the same decision is computed identically on the server
// (update-check endpoint) and can be surfaced read-only on the dashboard.
//
// SAFETY:
// - An update is BLOCKED while a live trade is open, a command is pending, the
//   heartbeat is unstable, the channel is disallowed, the kill switch is
//   engaged, maintenance policy blocks it, the manifest is not `approved`, the
//   EA cannot self-update, or the checksum is absent. ANY blocking condition →
//   BLOCK:<reason>. There is no "force" path.
// - Updating never weakens a safety surface; at worst the EA stays on its
//   current build and ARX surfaces "Manual bootstrap EA install required".

export const EA_UPDATE_BLOCK_REASONS = [
  "NO_APPROVED_MANIFEST",
  "MANIFEST_NOT_APPROVED",
  "CHANNEL_NOT_ALLOWED",
  "CHECKSUM_MISSING",
  "OPEN_LIVE_TRADE",
  "COMMAND_PENDING",
  "HEARTBEAT_UNSTABLE",
  "KILL_SWITCH_ENGAGED",
  "MAINTENANCE_MODE",
  "ALREADY_UP_TO_DATE",
  "MANUAL_BOOTSTRAP_REQUIRED",
] as const;
export type EaUpdateBlockReason = (typeof EA_UPDATE_BLOCK_REASONS)[number];

export type EaUpdateDecision = "ALLOW" | "BLOCK";

export interface EaUpdateGateInput {
  // Manifest under consideration (already filtered to the EA's channel).
  manifest: {
    version: string;
    channel: string;
    releaseStatus: string;             // draft | staged | approved | revoked
    sha256Checksum: string | null;
    isUpdaterCapable: boolean;
  } | null;
  currentVersion: string | null;       // EA's reported eaVersion
  allowedChannels: readonly string[];  // channels this EA is permitted to take
  eaSupportsSelfUpdate: boolean;       // capabilities.supportsSelfUpdate
  hasOpenLiveTrade: boolean;
  hasPendingCommand: boolean;
  heartbeatStable: boolean;            // heartbeat age within the stability window
  killSwitchEngaged: boolean;
  maintenanceMode: boolean;
}

export interface EaUpdateGateResult {
  decision: EaUpdateDecision;
  reason: EaUpdateBlockReason | null;  // null when ALLOW
  // True when an update exists but the EA cannot self-update — the operator
  // must do a manual bootstrap install. This is surfaced even on BLOCK so the
  // dashboard can show the right call to action.
  manualBootstrapRequired: boolean;
  targetVersion: string | null;
}

// Compare dotted numeric versions ("1.29" vs "1.28"). Returns >0 if a>b.
export function compareEaVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * Pure update-gate evaluator. Order of checks is deliberate: hard safety blocks
 * (kill switch, open trade, pending command, unstable heartbeat, maintenance)
 * are evaluated before "is there even an update", so the dashboard always shows
 * the most safety-relevant reason. Manifest validity is checked last.
 */
export function evaluateEaUpdateGate(input: EaUpdateGateInput): EaUpdateGateResult {
  const target = input.manifest?.version ?? null;

  // Does the manifest represent a newer, valid, approved, in-channel build that
  // the EA could self-apply? Compute this first so manualBootstrapRequired is
  // accurate on every branch.
  const manifestIsNewer =
    !!input.manifest &&
    !!input.currentVersion &&
    compareEaVersions(input.manifest.version, input.currentVersion) > 0;
  const updateExists = manifestIsNewer || (!!input.manifest && !input.currentVersion);
  const manualBootstrapRequired = updateExists && !input.eaSupportsSelfUpdate;

  const block = (reason: EaUpdateBlockReason): EaUpdateGateResult => ({
    decision: "BLOCK",
    reason,
    manualBootstrapRequired,
    targetVersion: target,
  });

  // ── Hard safety blocks first ──────────────────────────────────────────────
  if (input.killSwitchEngaged) return block("KILL_SWITCH_ENGAGED");
  if (input.maintenanceMode) return block("MAINTENANCE_MODE");
  if (input.hasOpenLiveTrade) return block("OPEN_LIVE_TRADE");
  if (input.hasPendingCommand) return block("COMMAND_PENDING");
  if (!input.heartbeatStable) return block("HEARTBEAT_UNSTABLE");

  // ── Manifest validity ─────────────────────────────────────────────────────
  if (!input.manifest) return block("NO_APPROVED_MANIFEST");
  if (input.manifest.releaseStatus !== "approved") return block("MANIFEST_NOT_APPROVED");
  if (!input.allowedChannels.includes(input.manifest.channel)) {
    return block("CHANNEL_NOT_ALLOWED");
  }
  if (!input.manifest.sha256Checksum || input.manifest.sha256Checksum.trim() === "") {
    return block("CHECKSUM_MISSING");
  }

  // ── Up-to-date? ───────────────────────────────────────────────────────────
  if (!updateExists) return block("ALREADY_UP_TO_DATE");

  // ── Update exists & all safety conditions pass ────────────────────────────
  // If the EA cannot self-update, the operator must bootstrap manually. This is
  // a BLOCK for the self-update path but with the explicit manual reason.
  if (!input.eaSupportsSelfUpdate) return block("MANUAL_BOOTSTRAP_REQUIRED");

  return {
    decision: "ALLOW",
    reason: null,
    manualBootstrapRequired: false,
    targetVersion: target,
  };
}
