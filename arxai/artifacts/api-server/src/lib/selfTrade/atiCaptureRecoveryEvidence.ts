// Receipts are selected by server configuration and checked against the owner's native study.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod/v4";
import { readAtiDevelopmentRecoveryAnchor, type readAtiResearch } from "./atiResearchLab.js";

type Study = NonNullable<Awaited<ReturnType<typeof readAtiResearch>>>;
const digest = z.hash("sha256");
const id = z.number().int().positive();
const timestamp = z.iso.datetime({ offset: true });
const key = z.string().regex(/^bar:\d+$/);
const identity = { runId: z.uuid(), registrationHash: digest, ownerId: id, agentId: id,
  baselineVersion: z.string(), challengerVersion: z.string() };
const registrationSources = z.record(digest, z.object({ file: z.string().refine(isAbsolute), sha256: digest }));
const evidence = z.object({
  rehearsal: z.object({ ...identity, scope: z.literal("REGISTERED_SHADOW_CAPTURE_TRANSACTION_RECOVERY"), executionAuthority: z.literal("NONE"),
    sourceAccess: z.literal("READ_ONLY"), rehearsalDatabase: z.literal("DISPOSABLE_SOCKET_ONLY_COPY"), completedAt: timestamp,
    build: z.object({ revision: z.string().regex(/^[0-9a-f]{40}$/), sourceState: z.literal("clean") }),
    bundleSha256: digest, phase: z.literal("DEVELOPMENT"), failure: z.literal("SIGKILL_DURING_SHADOW_INSERT_AFTER_NATIVE_DECISION_INSERT"),
    interruptedDecisionId: id, interruptedObservationKey: key, partialCommit: z.literal(false),
    restartedObservation: z.object({ observationKey: key, decisionId: id, settingsHash: digest, sourceIdentity: z.string().min(1), cycleId: z.string().min(1) }),
    observedAttemptsOnRecoveredBar: z.number().int().min(2), retainedComparisonsOnBar: z.literal(1),
    repeatedAfterSecondRestart: z.literal(true), brokerCommands: z.literal(0) }),
  independentSourceAnchor: z.object({ ...identity, revision: z.string(), sourceIdentity: z.string(), settingsHash: digest,
    observationKey: key, nativeDecisionId: id, nativeCycle: z.string(), recordedAt: timestamp, checkedAt: timestamp }),
});

export async function readAtiCaptureRehearsal(study: Study, reviewedAt: Date) {
  const config = process.env.ARX_ATI_CAPTURE_RECOVERY_RECEIPTS;
  if (!config) return null;
  const unavailable = { status: "RECEIPT_UNVERIFIED" as const };
  let parsed;
  let sha256: string;
  try {
    const location = registrationSources.parse(JSON.parse(config))[study.registrationHash];
    if (!location) return null;
    const bytes = await readFile(location.file);
    sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== location.sha256) return unavailable;
    parsed = evidence.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    return unavailable;
  }
  const { rehearsal: r, independentSourceAnchor: a } = parsed;
  const { runId, ownerId, agentId, build, spec, definition } = study.registration;
  const recovered = r.restartedObservation;
  const completed = Date.parse(r.completedAt), checked = Date.parse(a.checkedAt);
  if (![r,a].every(item => item.runId === runId && item.ownerId === ownerId && item.agentId === agentId &&
      item.registrationHash === study.registrationHash && item.baselineVersion === definition.baselineVersion &&
      item.challengerVersion === definition.challengerVersion) ||
      build.sourceState !== "clean" || build.revision !== r.build.revision || build.revision !== a.revision ||
      spec.symbol !== "V75" || definition.timeframe !== "M5" || spec.market.source !== "deriv_public" ||
      completed < spec.startsAtMs || completed >= spec.developmentEndsAtMs || checked < completed || checked > +reviewedAt ||
      Date.parse(a.recordedAt) > checked || recovered.decisionId <= r.interruptedDecisionId ||
      recovered.cycleId === a.nativeCycle || r.interruptedObservationKey !== a.observationKey || recovered.observationKey !== a.observationKey ||
      recovered.sourceIdentity !== a.sourceIdentity || recovered.settingsHash !== a.settingsHash) return unavailable;
  if (study.status === "SEALED" && (study.dataset.sourceIdentity !== a.sourceIdentity ||
      study.dataset.decisionSettingsHash !== a.settingsHash)) return unavailable;
  const native = await readAtiDevelopmentRecoveryAnchor(study.registration, a.observationKey);
  if (!native || native.decisionId !== a.nativeDecisionId || native.cycleId !== a.nativeCycle ||
      native.version.build.revision !== a.revision || native.version.decisionSettingsHash !== a.settingsHash ||
      native.sourceIdentity !== a.sourceIdentity || native.recordedAtMs !== Date.parse(a.recordedAt)) return unavailable;
  return { status: "SHADOW_CAPTURE_RESTART_VERIFIED" as const, runId, registrationHash: study.registrationHash,
    revision: build.revision, settingsHash: a.settingsHash, observationKey: a.observationKey,
    receiptSha256: sha256, bundleSha256: r.bundleSha256, completedAt: r.completedAt,
    captureAttempts: r.observedAttemptsOnRecoveredBar, retainedComparisons: r.retainedComparisonsOnBar };
}
