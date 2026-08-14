// agentSchemaVersion — single source of truth for agent output versions.
// Lets us evolve agents one at a time without breaking the contract: when
// CONTRACT_SCHEMA_VERSION bumps to 3.0.0, agents on 2.x still validate but
// are flagged as outdated. Per-agent versions are bumped when an agent's
// scoring logic materially changes.

/** Top-level schema version for AgentOutputContract. */
export const CONTRACT_SCHEMA_VERSION = "2.0.0" as const;

/** Per-agent semver. Bump on logic changes so drift detector + shadow
 *  comparison can attribute behavior changes to a known release. */
export const AGENT_VERSIONS: Record<string, string> = {
  RISK: "2.0.0", EXEC: "2.0.0", NEWS: "2.0.0", DNA: "2.0.0",
  TREND: "2.0.0", MOMO: "2.0.0", LIQ: "2.0.0", STRUCT: "2.0.0",
  VOL: "2.0.0", SESSION: "2.0.0", PRECISION: "2.0.0", HIST: "2.0.0",
};

export function versionOf(agentId: string): string {
  return AGENT_VERSIONS[agentId] ?? "0.0.0";
}

/** Strict semver compatibility: same MAJOR ⇒ compatible. */
export function isCompatibleVersion(a: string, b: string): boolean {
  const [aMajor] = a.split(".");
  const [bMajor] = b.split(".");
  return aMajor === bMajor && aMajor !== "0";
}

/** Used by shadow comparison + drift detector to label a release pair.
 *  Any non-major semver change (minor OR patch) surfaces as MINOR_DIFF so
 *  that patch-level drift cannot silently slip past the drift detector. */
export function compareVersions(left: string, right: string): "SAME" | "MINOR_DIFF" | "MAJOR_DIFF" {
  if (left === right) return "SAME";
  const [lM] = left.split(".");
  const [rM] = right.split(".");
  if (lM !== rM) return "MAJOR_DIFF";
  return "MINOR_DIFF";
}
