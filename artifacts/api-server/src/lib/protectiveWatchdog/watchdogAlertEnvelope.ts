// Capability #28 — the wire contract between the watchdog PROCESS and the
// main app's notification service.
//
// This module is PURE and is imported by BOTH sides:
//   - the watchdog process (artifacts/api-server/src/watchdog.ts) builds an
//     envelope from its findings and POSTs it;
//   - the app-side ingest route (routes/watchdogIngest.ts) parses one back.
//
// It therefore may not import anything: no `pg`, no `@workspace/db`, no zod,
// no app module. Hand-rolled validation keeps the watchdog's transitive
// dependency surface at exactly `pg` + node builtins (pinned by the
// separation test).
//
// HONESTY RULES ENCODED HERE:
//   - `passVerdict` is DERIVED from the findings, never asserted by the
//     caller. A pass that could not read is CANNOT_VERIFY; a pass with any
//     CRITICAL is FINDINGS; only a pass that read everything and found no
//     CRITICAL is VERIFIED_HEALTHY. There is no code path that lets an
//     unreadable pass be labelled healthy (`deriveVerdict` is total).
//   - Evidence is REDACTED before it leaves the watchdog: `userId` and any
//     secret-shaped key are stripped, so an operator alert about user A's
//     position never carries user A's identity to user B's screen.

export const WATCHDOG_ALERT_ENVELOPE_VERSION = 1 as const;
export const WATCHDOG_ALERT_SOURCE = "arx-protection-watchdog" as const;

export type WatchdogWireSeverity = "INFO" | "WARN" | "CRITICAL";

/** A finding as it travels the wire — evidence already redacted. */
export interface WatchdogWireFinding {
  key: string;
  severity: WatchdogWireSeverity;
  message: string;
  evidence: Record<string, unknown>;
}

/**
 * The three honest outcomes of one watchdog pass.
 * CANNOT_VERIFY exists so "I could not read" can never be spelled the same
 * way as "everything is fine".
 */
export type WatchdogPassVerdict = "VERIFIED_HEALTHY" | "FINDINGS" | "CANNOT_VERIFY";

export interface WatchdogAlertEnvelope {
  version: typeof WATCHDOG_ALERT_ENVELOPE_VERSION;
  source: typeof WATCHDOG_ALERT_SOURCE;
  /** Stable per-deployment id so two watchdogs never overwrite each other's heartbeat. */
  instanceId: string;
  /** Which topology this instance believes it is running in (a claim, self-reported). */
  topology: string;
  atIso: string;
  passVerdict: WatchdogPassVerdict;
  /** Findings NEW this pass (repeat-suppressed upstream). */
  findings: WatchdogWireFinding[];
  counts: {
    findingsTotal: number;
    critical: number;
    cannotVerify: number;
  };
  /** Uptime of the watchdog process itself, so a flapping watchdog is visible. */
  uptimeSeconds: number;
}

// ── Redaction ───────────────────────────────────────────────────────────────

const SECRET_KEY_RE = /(token|secret|password|passwd|pwd|api[_-]?key|authorization|cookie|credential|connection[_-]?string|database[_-]?url)/i;
/** Identity keys stripped so an operator-facing alert carries no other user's identity. */
const IDENTITY_KEY_RE = /^(user_?id|email|account_?number|login)$/i;

export function redactEvidence(evidence: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!evidence) return out;
  for (const [k, v] of Object.entries(evidence)) {
    if (IDENTITY_KEY_RE.test(k)) continue;              // dropped, not masked — it is not needed downstream
    if (SECRET_KEY_RE.test(k)) { out[k] = "[REDACTED]"; continue; }
    if (v === null || typeof v === "number" || typeof v === "boolean") { out[k] = v; continue; }
    if (typeof v === "string") { out[k] = v.slice(0, 240); continue; }
    // Anything structured is summarised rather than forwarded verbatim: the
    // wire payload must stay bounded and must not smuggle nested identity.
    out[k] = `[${Array.isArray(v) ? "array" : typeof v}]`;
  }
  return out;
}

// ── Verdict derivation (total; the honesty spine of this module) ────────────

export function deriveVerdict(findings: readonly { key: string; severity: WatchdogWireSeverity }[]): WatchdogPassVerdict {
  if (findings.some((f) => f.key.startsWith("cannot_verify:"))) return "CANNOT_VERIFY";
  if (findings.some((f) => f.severity === "CRITICAL")) return "FINDINGS";
  if (findings.length > 0) return "FINDINGS";
  return "VERIFIED_HEALTHY";
}

// ── Build ───────────────────────────────────────────────────────────────────

export interface BuildEnvelopeArgs {
  instanceId: string;
  topology: string;
  /** ALL findings active this pass (not only the newly-alerted ones) — the
   *  verdict must reflect the ongoing condition, not the delta. */
  activeFindings: readonly { key: string; severity: WatchdogWireSeverity; message: string; evidence?: Record<string, unknown> }[];
  /** Findings to actually alert on (repeat-suppressed delta). */
  newFindings: readonly { key: string; severity: WatchdogWireSeverity; message: string; evidence?: Record<string, unknown> }[];
  nowMs: number;
  uptimeSeconds: number;
}

export function buildAlertEnvelope(args: BuildEnvelopeArgs): WatchdogAlertEnvelope {
  const active = args.activeFindings;
  return {
    version: WATCHDOG_ALERT_ENVELOPE_VERSION,
    source: WATCHDOG_ALERT_SOURCE,
    instanceId: args.instanceId.slice(0, 64),
    topology: args.topology.slice(0, 32),
    atIso: new Date(args.nowMs).toISOString(),
    passVerdict: deriveVerdict(active),
    findings: args.newFindings.map((f) => ({
      key: String(f.key).slice(0, 120),
      severity: f.severity,
      message: String(f.message).slice(0, 400),
      evidence: redactEvidence(f.evidence),
    })),
    counts: {
      findingsTotal: active.length,
      critical: active.filter((f) => f.severity === "CRITICAL").length,
      cannotVerify: active.filter((f) => f.key.startsWith("cannot_verify:")).length,
    },
    uptimeSeconds: Math.max(0, Math.floor(args.uptimeSeconds)),
  };
}

// ── Parse (app side) ────────────────────────────────────────────────────────

export type ParseResult =
  | { ok: true; value: WatchdogAlertEnvelope }
  | { ok: false; reason: string };

const SEVERITIES = new Set<string>(["INFO", "WARN", "CRITICAL"]);
const VERDICTS = new Set<string>(["VERIFIED_HEALTHY", "FINDINGS", "CANNOT_VERIFY"]);
/** Hard cap so a malformed or hostile POST cannot fan out unbounded notifications. */
export const MAX_WIRE_FINDINGS = 50;

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

export function parseAlertEnvelope(raw: unknown): ParseResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "body_not_an_object" };
  const o = raw as Record<string, unknown>;
  if (o.version !== WATCHDOG_ALERT_ENVELOPE_VERSION) return { ok: false, reason: `unsupported_version:${String(o.version)}` };
  if (o.source !== WATCHDOG_ALERT_SOURCE) return { ok: false, reason: "unexpected_source" };

  const instanceId = str(o.instanceId, 64);
  if (!instanceId) return { ok: false, reason: "missing_instance_id" };
  const topology = str(o.topology, 32) ?? "unknown";
  const atIso = str(o.atIso, 40);
  if (!atIso || !Number.isFinite(Date.parse(atIso))) return { ok: false, reason: "invalid_at_iso" };
  const passVerdict = str(o.passVerdict, 20);
  if (!passVerdict || !VERDICTS.has(passVerdict)) return { ok: false, reason: "invalid_pass_verdict" };

  const rawFindings = Array.isArray(o.findings) ? o.findings : null;
  if (rawFindings === null) return { ok: false, reason: "findings_not_an_array" };
  if (rawFindings.length > MAX_WIRE_FINDINGS) return { ok: false, reason: "too_many_findings" };

  const findings: WatchdogWireFinding[] = [];
  for (const f of rawFindings) {
    if (f === null || typeof f !== "object") return { ok: false, reason: "finding_not_an_object" };
    const fo = f as Record<string, unknown>;
    const key = str(fo.key, 120);
    const severity = str(fo.severity, 10);
    const message = str(fo.message, 400);
    if (!key) return { ok: false, reason: "finding_missing_key" };
    if (!severity || !SEVERITIES.has(severity)) return { ok: false, reason: "finding_invalid_severity" };
    if (!message) return { ok: false, reason: "finding_missing_message" };
    findings.push({
      key,
      severity: severity as WatchdogWireSeverity,
      message,
      // Re-redact on receipt: the app never trusts that the sender redacted.
      evidence: redactEvidence(fo.evidence as Record<string, unknown> | undefined),
    });
  }

  const counts = (o.counts ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

  return {
    ok: true,
    value: {
      version: WATCHDOG_ALERT_ENVELOPE_VERSION,
      source: WATCHDOG_ALERT_SOURCE,
      instanceId,
      topology,
      atIso,
      passVerdict: passVerdict as WatchdogPassVerdict,
      findings,
      counts: {
        findingsTotal: num(counts.findingsTotal),
        critical: num(counts.critical),
        cannotVerify: num(counts.cannotVerify),
      },
      uptimeSeconds: num(o.uptimeSeconds),
    },
  };
}
