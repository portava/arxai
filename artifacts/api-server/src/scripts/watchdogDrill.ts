// Capability #28 — THE DRILL, runnable.
//
//   pnpm --filter @workspace/api-server run drill:watchdog
//   pnpm --filter @workspace/api-server run drill:watchdog -- --deliver
//
// Replays each seeded scenario in watchdogDrillFixtures.ts through the REAL
// assessment core, the REAL wire envelope and the REAL notification mapper,
// and prints what a human would see. Exit 0 only if every scenario produced
// the finding it was supposed to produce.
//
// DRY RUN BY DEFAULT. `--deliver` additionally POSTs each envelope to the live
// ingest endpoint so the owner can prove the alert reaches their screen and
// their phone. Every drill envelope carries a `drill:<scenario>` instance id;
// the notification mapper keys off that id and prefixes BOTH the notification
// title (which is what web push shows first) and the message with
// "DRILL (not a real condition) —", and routes the drill to its own
// notificationType so it never occupies a real alert's dedupe slot. The drill
// also labels the wire message itself, so the raw envelope in a webhook or a
// log line is self-describing too.
//
// Procedure and expected output: docs/WATCHDOG_DRILL.md.

import { assessSnapshot } from "../lib/protectiveWatchdog/watchdogCore.js";
import { buildAlertEnvelope } from "../lib/protectiveWatchdog/watchdogAlertEnvelope.js";
import {
  mapEnvelopeToNotifications,
  WATCHDOG_DRILL_INSTANCE_PREFIX,
  WATCHDOG_DRILL_LABEL,
} from "../lib/protectiveWatchdog/watchdogNotificationMapper.js";
import {
  alertSinkConfigFromEnv,
  deliverAlert,
  summariseDelivery,
} from "../lib/protectiveWatchdog/watchdogAlertSink.js";
import { DRILL_NOW_MS, DRILL_SCENARIOS, type DrillScenario } from "../lib/protectiveWatchdog/watchdogDrillFixtures.js";

/** One definition, owned by the mapper — the drill and the app must agree. */
const DRILL_PREFIX = WATCHDOG_DRILL_LABEL;
const drillInstanceId = (id: string): string => `${WATCHDOG_DRILL_INSTANCE_PREFIX}${id}`;

function out(line: string): void {
  process.stdout.write(line + "\n");
}

export interface DrillOutcome {
  id: string;
  passed: boolean;
  verdict: string;
  actualKeys: string[];
  missingKeys: string[];
  notificationTitles: string[];
  delivery: string | null;
}

export function runScenarioOffline(s: DrillScenario): DrillOutcome {
  const assessment = assessSnapshot(s.snapshot, DRILL_NOW_MS);
  const envelope = buildAlertEnvelope({
    instanceId: drillInstanceId(s.id),
    topology: "unknown",
    activeFindings: assessment.findings,
    newFindings: assessment.findings,
    nowMs: DRILL_NOW_MS,
    uptimeSeconds: 0,
  });
  const actualKeys = envelope.findings.map((f) => f.key);
  const missingKeys = s.expectedFindingKeys.filter((k) => !actualKeys.includes(k));
  const notifications = mapEnvelopeToNotifications(envelope.findings, envelope.instanceId);
  return {
    id: s.id,
    passed: missingKeys.length === 0 && envelope.passVerdict === s.expectedVerdict,
    verdict: envelope.passVerdict,
    actualKeys,
    missingKeys,
    notificationTitles: notifications.map((n) => `[${n.severity}] ${n.title} → ${n.actionTarget}`),
    delivery: null,
  };
}

async function main(): Promise<void> {
  const deliver = process.argv.includes("--deliver");
  const config = alertSinkConfigFromEnv(process.env);

  out("");
  out("═══ ARX #28 — INDEPENDENT PROTECTION WATCHDOG DRILL ═══");
  out(`mode: ${deliver ? "DELIVER (alerts will be POSTed to the live ingest)" : "DRY RUN (nothing is sent)"}`);
  out(`ingest configured: url=${config.ingestUrl ? "yes" : "NO"} token=${config.ingestToken ? "yes" : "NO"}`);
  if (deliver && (!config.ingestUrl || !config.ingestToken)) {
    out("REFUSING to run --deliver: the alert path is not armed. Set ARX_WATCHDOG_ALERT_INGEST_URL and ARX_WATCHDOG_INGEST_TOKEN (owner press).");
    process.exit(2);
  }
  out("");

  const outcomes: DrillOutcome[] = [];
  for (const s of DRILL_SCENARIOS) {
    const o = runScenarioOffline(s);

    if (deliver) {
      const assessment = assessSnapshot(s.snapshot, Date.now());
      const labelled = assessment.findings.map((f) => ({ ...f, message: DRILL_PREFIX + f.message }));
      const envelope = buildAlertEnvelope({
        instanceId: drillInstanceId(s.id),
        topology: "unknown",
        activeFindings: labelled,
        newFindings: labelled,
        nowMs: Date.now(),
        uptimeSeconds: 0,
      });
      const results = await deliverAlert(envelope, config, fetch as never);
      o.delivery = summariseDelivery(results);
    }

    outcomes.push(o);
    out(`── ${s.id} ${o.passed ? "PASS" : "FAIL"}`);
    out(`   ${s.title}`);
    out(`   proves: ${s.proves}`);
    out(`   verdict: ${o.verdict} (expected ${s.expectedVerdict})`);
    out(`   findings: ${o.actualKeys.length === 0 ? "(none)" : o.actualKeys.join(", ")}`);
    if (o.missingKeys.length > 0) out(`   MISSING EXPECTED: ${o.missingKeys.join(", ")}`);
    for (const t of o.notificationTitles) out(`   owner would see: ${t}`);
    if (o.delivery) out(`   delivery: ${o.delivery}`);
    out("");
  }

  const failed = outcomes.filter((o) => !o.passed);
  out(`RESULT: ${outcomes.length - failed.length}/${outcomes.length} scenarios passed.`);
  if (failed.length > 0) {
    out(`FAILED: ${failed.map((f) => f.id).join(", ")}`);
    process.exit(1);
  }
  out("The watchdog notices an unprotected position and a main-app outage, and refuses to call an unreadable database healthy.");
  process.exit(0);
}

void main();
