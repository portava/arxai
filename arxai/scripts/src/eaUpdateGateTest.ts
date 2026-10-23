// Task #32 — Pure unit test for the EA update gate + version comparison. No DB,
// no network.
//
// Proves:
//   1. compareEaVersions orders dotted numeric versions correctly.
//   2. evaluateEaUpdateGate ALLOWS only an approved, in-channel, newer manifest
//      with a checksum, while every blocking condition (kill switch,
//      maintenance, open trade, pending command, unstable heartbeat, not
//      approved, wrong channel, missing checksum, already up to date, EA cannot
//      self-update) returns BLOCK:<reason>. There is no force path.
//   3. manualBootstrapRequired surfaces when an update exists but the EA cannot
//      self-update.
//
// Run: pnpm --filter @workspace/scripts run test:ea-update-gate

import {
  evaluateEaUpdateGate,
  compareEaVersions,
  type EaUpdateGateInput,
} from "@workspace/domain/safety-contracts";

let pass = 0,
  fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    return;
  }
  fail++;
  failures.push(`[${name}] ${detail}`);
}

// ── 1. version compare ───────────────────────────────────────────────────────
check("1.29 > 1.28", compareEaVersions("1.29", "1.28") > 0);
check("1.28 < 1.29", compareEaVersions("1.28", "1.29") < 0);
check("1.29 == 1.29", compareEaVersions("1.29", "1.29") === 0);
check("1.30 > 1.29", compareEaVersions("1.30", "1.29") > 0);
check("2.0 > 1.99", compareEaVersions("2.0", "1.99") > 0);

// Base input: an approved, newer, in-channel manifest with checksum, EA can
// self-update, and every safety condition healthy → ALLOW.
function base(overrides: Partial<EaUpdateGateInput> = {}): EaUpdateGateInput {
  return {
    manifest: {
      version: "1.30",
      channel: "stable",
      releaseStatus: "approved",
      sha256Checksum: "a".repeat(64),
      isUpdaterCapable: true,
    },
    currentVersion: "1.29",
    allowedChannels: ["stable"],
    eaSupportsSelfUpdate: true,
    hasOpenLiveTrade: false,
    hasPendingCommand: false,
    heartbeatStable: true,
    killSwitchEngaged: false,
    maintenanceMode: false,
    ...overrides,
  };
}

// ── 2. happy path ────────────────────────────────────────────────────────────
{
  const r = evaluateEaUpdateGate(base());
  check("happy ALLOW", r.decision === "ALLOW", JSON.stringify(r));
  check("happy reason null", r.reason === null);
  check("happy target 1.30", r.targetVersion === "1.30");
  check("happy no bootstrap", r.manualBootstrapRequired === false);
}

// ── 2. each blocking condition ───────────────────────────────────────────────
const blockCases: Array<[string, Partial<EaUpdateGateInput>, string]> = [
  ["kill switch", { killSwitchEngaged: true }, "KILL_SWITCH_ENGAGED"],
  ["maintenance", { maintenanceMode: true }, "MAINTENANCE_MODE"],
  ["open trade", { hasOpenLiveTrade: true }, "OPEN_LIVE_TRADE"],
  ["pending cmd", { hasPendingCommand: true }, "COMMAND_PENDING"],
  ["unstable hb", { heartbeatStable: false }, "HEARTBEAT_UNSTABLE"],
  ["no manifest", { manifest: null }, "NO_APPROVED_MANIFEST"],
  [
    "not approved",
    {
      manifest: {
        version: "1.30",
        channel: "stable",
        releaseStatus: "staged",
        sha256Checksum: "a".repeat(64),
        isUpdaterCapable: true,
      },
    },
    "MANIFEST_NOT_APPROVED",
  ],
  ["wrong channel", { allowedChannels: ["beta"] }, "CHANNEL_NOT_ALLOWED"],
  [
    "missing checksum",
    {
      manifest: {
        version: "1.30",
        channel: "stable",
        releaseStatus: "approved",
        sha256Checksum: null,
        isUpdaterCapable: true,
      },
    },
    "CHECKSUM_MISSING",
  ],
  [
    "already up to date",
    {
      manifest: {
        version: "1.29",
        channel: "stable",
        releaseStatus: "approved",
        sha256Checksum: "a".repeat(64),
        isUpdaterCapable: true,
      },
    },
    "ALREADY_UP_TO_DATE",
  ],
  ["cannot self-update", { eaSupportsSelfUpdate: false }, "MANUAL_BOOTSTRAP_REQUIRED"],
];
for (const [name, overrides, expected] of blockCases) {
  const r = evaluateEaUpdateGate(base(overrides));
  check(`block:${name} decision`, r.decision === "BLOCK", JSON.stringify(r));
  check(`block:${name} reason`, r.reason === expected, `got ${r.reason}, want ${expected}`);
}

// ── 3. manualBootstrapRequired is true whenever an update exists but EA can't
//      self-update — even when another hard block fires first. ────────────────
{
  const r = evaluateEaUpdateGate(base({ eaSupportsSelfUpdate: false, killSwitchEngaged: true }));
  check("bootstrap surfaced under hard block", r.manualBootstrapRequired === true, JSON.stringify(r));
  check("hard block wins reason", r.reason === "KILL_SWITCH_ENGAGED", `got ${r.reason}`);
}

console.log(`ea-update-gate: ${pass}/${pass + fail} PASS`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL " + f);
  process.exit(1);
}
process.exit(0);
