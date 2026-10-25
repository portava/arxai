// One trader-editable limit store (Tier 1 Risk Governor).
//
// A trader's limits live in user_risk_settings; the pre-trade Risk Governor
// resolves them with the operator's user_risk_limits and the platform
// ceilings. risk_settings keeps only preferences (risk mode label,
// confidence floor, symbol rules, the trader's own live lock), and only
// lib/risk/userRiskSettings.ts may touch it — that module routes every limit
// field to user_risk_settings. This guard fails when:
//   1. any other server file references riskSettingsTable,
//   2. the store module loses its limit-field split (LEGACY_LIMIT_FIELDS),
//   3. the Risk Governor (lib/riskGovernor) reads risk_settings again.
// QA fixtures (__qa__, *.test.ts) and src/scripts are exempt.
//
// Pure source analysis: no network, no DB.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
export const STORE = "lib/risk/userRiskSettings.ts";

/** Problems for one server file (key relative to the API src). */
export function scanFile(key: string, src: string): string[] {
  const out: string[] = [];
  const touchesLegacy = /\briskSettingsTable\b/.test(src);
  if (key === STORE) {
    if (!/export const LEGACY_LIMIT_FIELDS\s*=/.test(src)) out.push("the store lost LEGACY_LIMIT_FIELDS (the limit-field split)");
    if (!/\bin LEGACY_LIMIT_FIELDS\b/.test(src)) out.push("the store no longer routes limit fields through LEGACY_LIMIT_FIELDS");
    return out;
  }
  if (key.startsWith("lib/riskGovernor/") && (touchesLegacy || /["'`]risk_settings["'`]/.test(src))) {
    out.push("the Risk Governor reads risk_settings; limits come from user_risk_settings only");
  } else if (touchesLegacy) {
    out.push(`references riskSettingsTable; use ${STORE} (limits live in user_risk_settings)`);
  }
  return out;
}

export function checkSingleLimitStore(): CheckResult {
  const violations: string[] = [];
  for (const file of walk(API_SRC, { skip: (p) => p.includes("__qa__") || p.endsWith(".test.ts") || p.includes("/src/scripts/") })) {
    if (!file.endsWith(".ts")) continue;
    const key = file.slice(API_SRC.length + 1);
    for (const v of scanFile(key, readFileSync(file, "utf8"))) violations.push(`${rel(file)}: ${v}`);
  }
  return { name: "single-limit-store", ok: violations.length === 0, violations, notes: [`limits: user_risk_settings; risk_settings preferences only via ${STORE}`] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkSingleLimitStore();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
