import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Resilience — TYPES
// Self-contained subdomain. Survives MT5 disconnects, bad data, latency
// spikes, websocket failures, and broker instability. Can force
// DEGRADED_MODE, LOCKDOWN, or SAFE_SHUTDOWN. Does not place trades.
// ═══════════════════════════════════════════════════════════════════════════

export const ServiceIdSchema = z.string().min(1).max(64);
export type ServiceId = z.infer<typeof ServiceIdSchema>;

export const SystemModeSchema = z.enum(["NORMAL", "DEGRADED_MODE", "LOCKDOWN", "SAFE_SHUTDOWN"]);
export type SystemMode = z.infer<typeof SystemModeSchema>;

export const HeartbeatSchema = z.object({
  serviceId: ServiceIdSchema,
  lastHeartbeatAtMs: z.number().nonnegative(),
  intervalMs: z.number().positive(),
  consecutiveMisses: z.int().nonnegative(),
});
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

export const HeartbeatVerdictSchema = z.object({
  serviceId: ServiceIdSchema,
  alive: z.boolean(),
  staleMs: z.number().nonnegative(),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type HeartbeatVerdict = z.infer<typeof HeartbeatVerdictSchema>;

export const FailoverPlanSchema = z.object({
  primaryId: ServiceIdSchema,
  failoverToId: ServiceIdSchema.nullable(),
  shouldFailover: z.boolean(),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type FailoverPlan = z.infer<typeof FailoverPlanSchema>;

export const DataIntegrityIssueSchema = z.enum([
  "GAP", "DUPLICATE_TICK", "OUT_OF_ORDER", "STALE_FEED", "CORRUPT_PRICE", "NONE",
]);
export type DataIntegrityIssue = z.infer<typeof DataIntegrityIssueSchema>;

export const DataIntegrityVerdictSchema = z.object({
  issue: DataIntegrityIssueSchema,
  trustworthy: z.boolean(),
  staleMs: z.number().nonnegative(),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type DataIntegrityVerdict = z.infer<typeof DataIntegrityVerdictSchema>;

export const ReconnectStateSchema = z.object({
  serviceId: ServiceIdSchema,
  attempts: z.int().nonnegative(),
  nextDelayMs: z.number().nonnegative(),
  shouldGiveUp: z.boolean(),
  reasons: z.array(z.string()),
});
export type ReconnectState = z.infer<typeof ReconnectStateSchema>;

export const DegradedModePlanSchema = z.object({
  active: z.boolean(),
  disabledFeatures: z.array(z.string()),
  reasons: z.array(z.string()),
});
export type DegradedModePlan = z.infer<typeof DegradedModePlanSchema>;

export const SafeShutdownPlanSchema = z.object({
  shouldShutdown: z.boolean(),
  steps: z.array(z.string()),
  reasons: z.array(z.string()),
});
export type SafeShutdownPlan = z.infer<typeof SafeShutdownPlanSchema>;

export const ResilienceVerdictSchema = z.object({
  generatedAtIso: z.string(),
  mode: SystemModeSchema,
  heartbeats: z.array(HeartbeatVerdictSchema),
  dataIntegrity: DataIntegrityVerdictSchema,
  failover: z.array(FailoverPlanSchema),
  reconnects: z.array(ReconnectStateSchema),
  degraded: DegradedModePlanSchema,
  shutdown: SafeShutdownPlanSchema,
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type ResilienceVerdict = z.infer<typeof ResilienceVerdictSchema>;

export function clampNonNegative(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x;
}
