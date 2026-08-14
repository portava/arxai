// Build MM — Audit Log Service.
//
// SAFETY: Audit logs are immutable diagnostics records. This service NEVER
// places trades, NEVER changes canPlaceTrades, NEVER calls MT5, NEVER exposes
// secrets. All inputs are scrubbed for secret-shaped substrings.

import { db, systemAuditLogsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

export type AuditSeverity = "INFO" | "WARNING" | "HIGH" | "CRITICAL";
export type AuditActor = "SYSTEM" | "ADMIN" | "USER";
export type AuditSourceBuild = "AA"|"BB"|"CC"|"DD"|"EE"|"FF"|"GG"|"HH"|"II"|"JJ"|"KK"|"LL"|"MM";

export interface AuditInput {
  eventType: string;
  severity?: AuditSeverity;
  sourceBuild?: AuditSourceBuild;
  sourceService?: string;
  actor?: AuditActor;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  beforeSnapshot?: unknown;
  afterSnapshot?: unknown;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

// ── Secret redaction (mirrors LL hardening) ────────────────────────────────
const SECRET_KEY_RE = /(api[_-]?key|api[_-]?secret|password|passwd|pwd|bearer|secret|token|auth|credential|broker[_-]?api)/i;
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?/g,
  /\b(?:sk|pk|rk|whsec|xox[baprs])_[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[poursa]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi,
  /(?:bearer\s+)[A-Za-z0-9._-]{12,}/gi,
];
const SECRET_KV_RE = /\b(api[_-]?key|api[_-]?secret|password|passwd|pwd|secret|token|auth|credential|broker[_-]?api[_-]?key|broker[_-]?api[_-]?secret)\s*[:=]\s*("[^"]+"|'[^']+'|[^\s,;}]+)/gi;

function scrubString(s: string): string {
  if (!s) return s;
  let out = s.replace(SECRET_KV_RE, (_m, k) => `${k}=[REDACTED]`);
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}
function scrub<T>(v: T): T {
  if (v == null) return v;
  if (typeof v === "string") return scrubString(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => scrub(x)) as unknown as T;
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) out[k] = "[REDACTED]";
      else out[k] = scrub(val);
    }
    return out as unknown as T;
  }
  return v;
}

export async function auditEvent(input: AuditInput): Promise<{ auditId: string; id: number }> {
  const auditId = `audit_${randomUUID()}`;
  const row = {
    auditId,
    eventType: input.eventType.slice(0, 80),
    severity: (input.severity ?? "INFO") as AuditSeverity,
    sourceBuild: (input.sourceBuild ?? "MM") as AuditSourceBuild,
    sourceService: (input.sourceService ?? "system-health").slice(0, 80),
    actor: (input.actor ?? "SYSTEM") as AuditActor,
    action: input.action.slice(0, 120),
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    beforeSnapshot: input.beforeSnapshot != null ? scrub(input.beforeSnapshot) : null,
    afterSnapshot: input.afterSnapshot != null ? scrub(input.afterSnapshot) : null,
    metadata: scrub(input.metadata ?? {}) as Record<string, unknown>,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ? scrubString(input.userAgent).slice(0, 200) : null,
  };
  const [inserted] = await db.insert(systemAuditLogsTable).values(row).returning({ id: systemAuditLogsTable.id });
  return { auditId, id: inserted!.id };
}

export async function listAudit(opts: { limit?: number; severity?: string; sourceBuild?: string; action?: string } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const conds: ReturnType<typeof eq>[] = [];
  if (opts.severity)    conds.push(eq(systemAuditLogsTable.severity, opts.severity));
  if (opts.sourceBuild) conds.push(eq(systemAuditLogsTable.sourceBuild, opts.sourceBuild));
  if (opts.action)      conds.push(eq(systemAuditLogsTable.action, opts.action));
  const q = conds.length
    ? db.select().from(systemAuditLogsTable).where(conds.length === 1 ? conds[0]! : (await import("drizzle-orm")).and(...conds))
    : db.select().from(systemAuditLogsTable);
  return q.orderBy(desc(systemAuditLogsTable.createdAt)).limit(limit);
}

export async function getAuditById(auditId: string) {
  const rows = await db.select().from(systemAuditLogsTable).where(eq(systemAuditLogsTable.auditId, auditId)).limit(1);
  return rows[0] ?? null;
}

export async function exportAudit(limit = 500) {
  const rows = await listAudit({ limit });
  return {
    exportId: `auditexp_${randomUUID()}`,
    generatedAt: new Date().toISOString(),
    count: rows.length,
    audits: rows,
  };
}

export async function seedAuditDemo() {
  const samples: AuditInput[] = [
    { eventType: "HEALTH_CHECK_RUN", severity: "INFO", sourceBuild: "MM", action: "run-full-health-check" },
    { eventType: "ADMIN_ACTION", severity: "INFO", sourceBuild: "MM", actor: "ADMIN", action: "stop-autopilot" },
    { eventType: "ADMIN_ACTION_REJECTED", severity: "CRITICAL", sourceBuild: "MM", actor: "ADMIN", action: "enable-live-trading", metadata: { reason: "FORBIDDEN" } },
    { eventType: "SAFETY_LOCK_ACTIVATED", severity: "HIGH", sourceBuild: "HH", action: "lock-trading", metadata: { code: "DEMO" } },
    { eventType: "NOTIFICATION_ACK", severity: "INFO", sourceBuild: "LL", actor: "ADMIN", action: "acknowledge-critical" },
  ];
  const ids: string[] = [];
  for (const s of samples) ids.push((await auditEvent(s)).auditId);
  return ids;
}
