// ═══════════════════════════════════════════════════════════════════════════
// security/prodDevSeparation.ts — pure prod/dev separation + supply-chain hygiene.
//
// Deterministic, no IO. The api-server gathers real environment signals and
// calls these to flag (or, in production, block) dangerous development
// behaviour leaking into production, plus basic secret/supply-chain hygiene.
//
// SAFETY: in PRODUCTION a confirmed dangerous-dev signal is a CRITICAL blocking
// finding; in dev it is a non-blocking WARN. A signal that cannot be verified is
// reported as `unverified` (honest UNKNOWN) — never silently treated as safe and
// never used to break a healthy production path on a false positive.
// ═══════════════════════════════════════════════════════════════════════════

export interface ProdDevSignals {
  isProduction: boolean;
  /** Dev email fallback (e.g. console/log sink) active. */
  devEmailFallbackActive?: boolean;
  /** Mock/simulator market data being served while in a live mode. */
  mockMarketDataInLiveMode?: boolean;
  /** A demo bridge servicing a live route. */
  demoBridgeOnLiveRoute?: boolean;
  /** Test-only endpoints reachable. */
  testEndpointsActive?: boolean;
  /** Debug panels visible to end users. */
  debugPanelVisibleToUsers?: boolean;
  /** Fake/synthetic execution reachable from a live route. */
  fakeExecutionInLiveRoute?: boolean;
}

export interface SecurityFinding {
  code: string;
  severity: "WARN" | "HIGH" | "CRITICAL";
  blocking: boolean;
  message: string;
}

export interface ProdDevVerdict {
  production: boolean;
  findings: SecurityFinding[];
  /** Signal keys that could not be verified (honest unknown). */
  unverified: string[];
  /** True when any blocking finding is present. */
  blocked: boolean;
  severity: "NONE" | "WARN" | "HIGH" | "CRITICAL";
  reasonCode: string;
}

const PROD_DEV_CHECKS: { key: keyof ProdDevSignals; code: string; message: string }[] = [
  { key: "devEmailFallbackActive", code: "DEV_EMAIL_FALLBACK_IN_PROD", message: "Development email fallback is active in production." },
  { key: "mockMarketDataInLiveMode", code: "MOCK_MARKET_DATA_IN_LIVE", message: "Mock market data is being served in a live mode." },
  { key: "demoBridgeOnLiveRoute", code: "DEMO_BRIDGE_ON_LIVE_ROUTE", message: "A demo bridge is servicing a live route." },
  { key: "testEndpointsActive", code: "TEST_ENDPOINTS_ACTIVE", message: "Test-only endpoints are reachable." },
  { key: "debugPanelVisibleToUsers", code: "DEBUG_PANEL_VISIBLE", message: "Debug panels are visible to end users." },
  { key: "fakeExecutionInLiveRoute", code: "FAKE_EXECUTION_IN_LIVE", message: "Synthetic execution is reachable from a live route." },
];

const SEVERITY_RANK: Record<"WARN" | "HIGH" | "CRITICAL", number> = { WARN: 1, HIGH: 2, CRITICAL: 3 };

function maxSeverity(findings: SecurityFinding[]): "NONE" | "WARN" | "HIGH" | "CRITICAL" {
  return findings.reduce<"NONE" | "WARN" | "HIGH" | "CRITICAL">((acc, f) => {
    const accRank = acc === "NONE" ? 0 : SEVERITY_RANK[acc];
    return SEVERITY_RANK[f.severity] > accRank ? f.severity : acc;
  }, "NONE");
}

export function evaluateProdDevSeparation(signals: ProdDevSignals): ProdDevVerdict {
  const findings: SecurityFinding[] = [];
  const unverified: string[] = [];

  for (const check of PROD_DEV_CHECKS) {
    const value = signals[check.key];
    if (value === undefined) {
      unverified.push(check.code);
      continue;
    }
    if (value === true) {
      findings.push({
        code: check.code,
        severity: signals.isProduction ? "CRITICAL" : "WARN",
        blocking: signals.isProduction,
        message: check.message,
      });
    }
  }

  const blocked = findings.some((f) => f.blocking);
  return {
    production: signals.isProduction,
    findings,
    unverified,
    blocked,
    severity: maxSeverity(findings),
    reasonCode: blocked ? "PROD_DEV_BLOCKED" : findings.length > 0 ? "PROD_DEV_WARN" : "PROD_DEV_OK",
  };
}

// ── Supply-chain / secret hygiene ───────────────────────────────────────────

export interface SupplyChainSignals {
  /** Secret usage detected in client-side code. */
  clientSideSecretUsageDetected?: boolean;
  /** Secrets detected in the shipped client bundle. */
  secretsInClientBundle?: boolean;
  /** Count of known vulnerable dependencies. */
  knownVulnerableDeps?: number;
  /** Count of unpinned dependencies. */
  unpinnedDependencies?: number;
}

export interface SupplyChainVerdict {
  findings: SecurityFinding[];
  unverified: string[];
  severity: "NONE" | "WARN" | "HIGH" | "CRITICAL";
  ok: boolean;
  reasonCode: string;
}

export function evaluateSupplyChainHygiene(signals: SupplyChainSignals): SupplyChainVerdict {
  const findings: SecurityFinding[] = [];
  const unverified: string[] = [];

  if (signals.clientSideSecretUsageDetected === undefined) unverified.push("CLIENT_SIDE_SECRET_USAGE");
  else if (signals.clientSideSecretUsageDetected) findings.push({ code: "CLIENT_SIDE_SECRET_USAGE", severity: "CRITICAL", blocking: true, message: "Secret usage detected in client-side code." });

  if (signals.secretsInClientBundle === undefined) unverified.push("SECRETS_IN_CLIENT_BUNDLE");
  else if (signals.secretsInClientBundle) findings.push({ code: "SECRETS_IN_CLIENT_BUNDLE", severity: "CRITICAL", blocking: true, message: "Secrets detected in the client bundle." });

  if (signals.knownVulnerableDeps === undefined) unverified.push("KNOWN_VULNERABLE_DEPS");
  else if (signals.knownVulnerableDeps > 0) findings.push({ code: "KNOWN_VULNERABLE_DEPS", severity: "HIGH", blocking: false, message: `${signals.knownVulnerableDeps} known vulnerable dependency(ies).` });

  if (signals.unpinnedDependencies === undefined) unverified.push("UNPINNED_DEPENDENCIES");
  else if (signals.unpinnedDependencies > 0) findings.push({ code: "UNPINNED_DEPENDENCIES", severity: "WARN", blocking: false, message: `${signals.unpinnedDependencies} unpinned dependency(ies).` });

  return {
    findings,
    unverified,
    severity: maxSeverity(findings),
    ok: findings.length === 0,
    reasonCode: findings.some((f) => f.blocking) ? "SUPPLY_CHAIN_BLOCKED" : findings.length > 0 ? "SUPPLY_CHAIN_WARN" : "SUPPLY_CHAIN_OK",
  };
}
