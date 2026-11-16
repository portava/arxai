// Task #32 — EA↔server contract parity test for GET /mt5/update-check.
//
// The EA's flat MQL5 JSON parser reads the actionable update fields at the TOP
// LEVEL of the response (`decision`, `reason`, `version`, `sha256Checksum`,
// `downloadUrl`, `isUpdaterCapable`). MQL5 cannot be compiled/run here, so this
// asserts the server's pure response builder emits exactly those keys at the top
// level — preventing the nested-vs-flat contract drift a code review caught.
//
// Proves:
//   - ALLOW serves the package (version/checksum/downloadUrl/isUpdaterCapable)
//     at the top level.
//   - BLOCK withholds the package (all package fields null/false) but still
//     carries decision + reason so the EA can report it.
//   - checksum-valid vs checksum-missing manifests round-trip correctly.
//
// Run: pnpm --filter @workspace/scripts run test:ea-update-check-contract

import {
  buildUpdateCheckResponse,
  type UpdateCheckManifest,
  type UpdateCheckDecision,
} from "../../artifacts/api-server/src/routes/mt5RemoteOps.js";

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

// Exactly the keys the EA's CheckForUpdateNow() parses out of the response.
const EA_PARSED_KEYS = [
  "decision",
  "reason",
  "version",
  "sha256Checksum",
  "downloadUrl",
  "isUpdaterCapable",
];

const manifest: UpdateCheckManifest = {
  version: "1.30",
  channel: "stable",
  sha256Checksum: "a".repeat(64),
  signature: null,
  downloadUrl: "https://example.test/ea/1.30.mq5",
  rollbackVersion: "1.29",
  changelog: "patch",
  isUpdaterCapable: true,
};

// ── ALLOW: every EA-parsed key present at top level + package served ──────────
{
  const allow: UpdateCheckDecision = {
    decision: "ALLOW",
    reason: null,
    manualBootstrapRequired: false,
    targetVersion: "1.30",
  };
  const r = buildUpdateCheckResponse(allow, manifest, "1.29", "SUPPORTED") as Record<string, unknown>;
  for (const k of EA_PARSED_KEYS) {
    check(`ALLOW has key:${k}`, k in r, "missing top-level key");
  }
  check("ALLOW version top-level", r.version === "1.30", String(r.version));
  check("ALLOW checksum top-level", r.sha256Checksum === "a".repeat(64));
  check("ALLOW downloadUrl top-level", r.downloadUrl === manifest.downloadUrl);
  check("ALLOW isUpdaterCapable true", r.isUpdaterCapable === true);
  // The EA must NOT have to read a nested manifest object.
  check("ALLOW no nested manifest", !("manifest" in r), "nested manifest reintroduced drift");
}

// ── BLOCK: package withheld, decision + reason still present ──────────────────
{
  const block: UpdateCheckDecision = {
    decision: "BLOCK",
    reason: "KILL_SWITCH_ENGAGED",
    manualBootstrapRequired: false,
    targetVersion: "1.30",
  };
  const r = buildUpdateCheckResponse(block, manifest, "1.29", "SUPPORTED") as Record<string, unknown>;
  check("BLOCK decision", r.decision === "BLOCK");
  check("BLOCK reason present", r.reason === "KILL_SWITCH_ENGAGED", String(r.reason));
  check("BLOCK version withheld", r.version === null, String(r.version));
  check("BLOCK checksum withheld", r.sha256Checksum === null);
  check("BLOCK downloadUrl withheld", r.downloadUrl === null);
  check("BLOCK isUpdaterCapable false", r.isUpdaterCapable === false);
}

// ── checksum-missing manifest on ALLOW: checksum surfaces as null, EA refuses ─
// (The gate would not normally ALLOW without a checksum, but the builder must
// faithfully surface null rather than fabricate one.)
{
  const allow: UpdateCheckDecision = {
    decision: "ALLOW",
    reason: null,
    manualBootstrapRequired: false,
    targetVersion: "1.30",
  };
  const noChecksum: UpdateCheckManifest = { ...manifest, sha256Checksum: null };
  const r = buildUpdateCheckResponse(allow, noChecksum, "1.29", "SUPPORTED") as Record<string, unknown>;
  check("missing-checksum is null", r.sha256Checksum === null, String(r.sha256Checksum));
  check("missing-checksum never fabricated", typeof r.sha256Checksum !== "string");
}

// ── ALLOW with null manifest cannot serve a package ──────────────────────────
{
  const allow: UpdateCheckDecision = {
    decision: "ALLOW",
    reason: null,
    manualBootstrapRequired: false,
    targetVersion: null,
  };
  const r = buildUpdateCheckResponse(allow, null, "1.29", "SUPPORTED") as Record<string, unknown>;
  check("ALLOW+null manifest withholds version", r.version === null);
  check("ALLOW+null manifest withholds url", r.downloadUrl === null);
}

console.log(`ea-update-check contract: ${pass}/${pass + fail} PASS`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL " + f);
  process.exit(1);
}
process.exit(0);
