// ARX Handshake System — clean user-facing copy unit tests (PURE, no DB).
//
// Verifies that `buildHandshakeCopy` (the advisory copy module) is:
//   1. CLEAN — every message + recommendation across every handshake type ×
//      readiness status passes `findInternalLeaks` (no SCREAMING_SNAKE gate/env
//      codes, route paths, layer keys, provider names, or operator reasons).
//   2. ON-SURFACE — the required human phrases are present for the right
//      family/status combination.
//   3. DETERMINISTIC — same input → byte-identical output.
//
// The copy module is advisory only; it never gates execution. The real stop is
// the 16-gate live pipeline.
//
// Run: pnpm --filter @workspace/scripts run test:handshake-copy

import {
  buildHandshakeCopy,
  HANDSHAKE_TYPES,
  HANDSHAKE_READINESS_STATUSES,
} from "@workspace/domain/handshake";
import { findInternalLeaks } from "@workspace/domain/security";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.error(`  FAIL  ${name}`);
    failures++;
  }
}

console.log("Handshake user-facing copy test");

// 1. Every type × status produces clean, non-empty copy (no internal leaks).
{
  let allClean = true;
  let allNonEmpty = true;
  for (const type of HANDSHAKE_TYPES) {
    for (const status of HANDSHAKE_READINESS_STATUSES) {
      const copy = buildHandshakeCopy(type, status);
      const blobs = [copy.userFacingMessage, ...copy.recommendations];
      for (const blob of blobs) {
        const leaks = findInternalLeaks(blob);
        if (leaks.length > 0) {
          allClean = false;
          console.error(`    LEAK ${type}/${status}: ${leaks.join(", ")} in "${blob}"`);
        }
      }
      if (!copy.userFacingMessage || copy.userFacingMessage.trim().length === 0) {
        allNonEmpty = false;
        console.error(`    EMPTY message for ${type}/${status}`);
      }
    }
  }
  check("all type × status copy is free of internal leaks", allClean);
  check("all type × status copy has a non-empty user message", allNonEmpty);
}

// 2. Required on-surface phrases are present for the right family/status.
{
  // Investor family READY — exact phrase.
  check(
    'INVESTOR_VALUE READY → "Portfolio Status: Fresh."',
    buildHandshakeCopy("INVESTOR_VALUE", "READY").userFacingMessage === "Portfolio Status: Fresh.",
  );
  // Execution family WAITING_FOR_DATA — exact phrase.
  check(
    'TRADE_PREVIEW WAITING_FOR_DATA → "Waiting for fresh price…"',
    buildHandshakeCopy("TRADE_PREVIEW", "WAITING_FOR_DATA").userFacingMessage ===
      "Waiting for fresh price…",
  );
  // Execution family STALE — exact phrase.
  check(
    'TRADE_PREVIEW STALE → "Late — do not chase."',
    buildHandshakeCopy("TRADE_PREVIEW", "STALE").userFacingMessage === "Late — do not chase.",
  );
  // Execution family BLOCKED — phrase prefix.
  check(
    'TRADE_PREVIEW BLOCKED → "Live bridge is not ready…"',
    buildHandshakeCopy("TRADE_PREVIEW", "BLOCKED").userFacingMessage.startsWith(
      "Live bridge is not ready",
    ),
  );
}

// 3. READY states never push a "double-check" / caution recommendation.
{
  const ready = buildHandshakeCopy("MARKET_DATA", "READY");
  check("READY has no caution recommendations", ready.recommendations.length === 0);
}

// 4. Deterministic — same input yields identical output.
{
  const a = buildHandshakeCopy("BROKER_BRIDGE", "DEGRADED");
  const b = buildHandshakeCopy("BROKER_BRIDGE", "DEGRADED");
  check(
    "buildHandshakeCopy is deterministic",
    JSON.stringify(a) === JSON.stringify(b),
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll handshake copy checks passed.");

export {};
