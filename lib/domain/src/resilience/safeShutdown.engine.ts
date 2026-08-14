import {
  type SafeShutdownPlan, type HeartbeatVerdict, type DataIntegrityVerdict,
} from "./resilience.types";

// ═══════════════════════════════════════════════════════════════════════════
// Safe Shutdown — escalates beyond DEGRADED when essential services or
// data are unrecoverable. Returns an ordered checklist for the operator
// (close positions → cancel orders → flush vault → stop agents → exit).
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface ShutdownInput {
  essentialServiceIds: ReadonlyArray<string>;
  heartbeats: ReadonlyArray<HeartbeatVerdict>;
  dataIntegrity: DataIntegrityVerdict;
  reconnectGivenUp: boolean;
}

export function planSafeShutdown(input: ShutdownInput): SafeShutdownPlan {
  const reasons: string[] = [];
  const essentialDead = input.heartbeats.filter((h) =>
    input.essentialServiceIds.includes(h.serviceId) && !h.alive);
  const corrupt = input.dataIntegrity.issue === "CORRUPT_PRICE";
  const stale  = input.dataIntegrity.issue === "STALE_FEED";

  const shouldShutdown =
       essentialDead.length > 0
    || corrupt
    || (stale && input.reconnectGivenUp);

  const steps: string[] = [];
  if (shouldShutdown) {
    steps.push("Halt new entries");
    steps.push("Close all open positions at market (or per emergency policy)");
    steps.push("Cancel all working orders");
    steps.push("Flush Black Box Vault to durable store");
    steps.push("Stop nonessential agents");
    steps.push("Send operator alert");
    steps.push("Exit process safely");
    reasons.push(
      `SHUTDOWN: ${essentialDead.length ? `essential services dead (${essentialDead.map((d) => d.serviceId).join(",")}); ` : ""}` +
      `${corrupt ? "corrupt price feed; " : ""}${stale && input.reconnectGivenUp ? "stale feed + reconnect gave up; " : ""}`);
  } else {
    reasons.push(`shutdown not required`);
  }
  return { shouldShutdown, steps, reasons };
}
