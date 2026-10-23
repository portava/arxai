// Task #30 — pure unit test for the EA-host clock-drift evaluator.
//
// The EA reports its own GMT clock in every heartbeat. ARX compares it to its
// receive time, flags drift, stops trusting latency when drift is significant,
// and blocks the Live Test Cycle on SEVERE drift.
//
// SAFETY: severe drift can ONLY add a refusal — it never relaxes any gate.
// These assertions pin the OK / WARN / SEVERE thresholds and the
// blockLiveTestCycle decision.

import {
  evaluateClockDrift,
  normalizeEaEpochToMs,
  CLOCK_DRIFT_WARN_SECONDS,
  CLOCK_DRIFT_SEVERE_SECONDS,
} from "@workspace/domain/safety-contracts/clockDrift";

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

const NOW = 1_700_000_000_000;

// 1. Small drift (network latency) — OK, latency trusted, no block.
{
  const r = evaluateClockDrift({ eaGmtMs: NOW - 2_000, serverReceivedMs: NOW });
  record(
    "small drift is OK",
    r.severity === "OK" && r.trustLatency === true && r.blockLiveTestCycle === false,
    `severity=${r.severity} trustLatency=${r.trustLatency} block=${r.blockLiveTestCycle} drift=${r.driftSeconds}`,
  );
}

// 2. WARN-band drift — flagged, latency untrusted, but no Live-Test block.
{
  const driftMs = (CLOCK_DRIFT_WARN_SECONDS + 10) * 1000;
  const r = evaluateClockDrift({ eaGmtMs: NOW - driftMs, serverReceivedMs: NOW });
  record(
    "warn-band drift warns but does not block",
    r.severity === "WARN" && r.trustLatency === false && r.blockLiveTestCycle === false && r.flags.includes("EA_CLOCK_BEHIND"),
    `severity=${r.severity} trustLatency=${r.trustLatency} block=${r.blockLiveTestCycle} flags=${r.flags.join(",")}`,
  );
}

// 3. SEVERE drift — blocks the Live Test Cycle.
{
  const driftMs = (CLOCK_DRIFT_SEVERE_SECONDS + 30) * 1000;
  const r = evaluateClockDrift({ eaGmtMs: NOW - driftMs, serverReceivedMs: NOW });
  record(
    "severe drift blocks live test cycle",
    r.severity === "SEVERE" && r.blockLiveTestCycle === true && r.trustLatency === false,
    `severity=${r.severity} block=${r.blockLiveTestCycle} drift=${r.driftSeconds}`,
  );
}

// 4. EA clock ahead (future timestamp) — flagged, severe blocks.
{
  const driftMs = (CLOCK_DRIFT_SEVERE_SECONDS + 30) * 1000;
  const r = evaluateClockDrift({ eaGmtMs: NOW + driftMs, serverReceivedMs: NOW });
  record(
    "ea clock ahead flagged and blocked",
    r.severity === "SEVERE" && r.blockLiveTestCycle === true && r.flags.includes("EA_CLOCK_AHEAD") && r.flags.includes("TIMESTAMP_IN_FUTURE"),
    `severity=${r.severity} block=${r.blockLiveTestCycle} flags=${r.flags.join(",")}`,
  );
}

// 5. Unparseable EA time — WARN, latency untrusted, but never blocks.
{
  const r = evaluateClockDrift({ eaGmtMs: null, serverReceivedMs: NOW });
  record(
    "unparseable ea time warns without block",
    r.severity === "WARN" && r.trustLatency === false && r.blockLiveTestCycle === false && r.flags.includes("TIMESTAMP_UNPARSEABLE") && r.driftSeconds === null,
    `severity=${r.severity} block=${r.blockLiveTestCycle} flags=${r.flags.join(",")} drift=${r.driftSeconds}`,
  );
}

// 6. Regression: a REAL EA heartbeat sends a seconds-scale GMT epoch
//    (MQL5 TimeGMT() returns seconds). normalizeEaEpochToMs must scale it up so
//    a healthy clock reads OK — NOT a ~1000x SEVERE false-trip.
{
  const nowSec = Math.floor(NOW / 1000); // what an older EA would send (seconds)
  const norm = normalizeEaEpochToMs(nowSec);
  const r = evaluateClockDrift({ eaGmtMs: norm, serverReceivedMs: NOW });
  record(
    "seconds-scale ea epoch normalizes to OK",
    norm === NOW && r.severity === "OK" && r.blockLiveTestCycle === false,
    `norm=${norm} severity=${r.severity} block=${r.blockLiveTestCycle} drift=${r.driftSeconds}`,
  );
}

// 7. A ms-scale epoch (new EA, already *1000) must pass through untouched.
{
  const norm = normalizeEaEpochToMs(NOW);
  record(
    "ms-scale ea epoch passes through unchanged",
    norm === NOW,
    `norm=${norm} (expected ${NOW})`,
  );
}

// 8. Without normalization, raw seconds WOULD false-trip SEVERE — proving the
//    bug the normalizer fixes is real.
{
  const nowSec = Math.floor(NOW / 1000);
  const r = evaluateClockDrift({ eaGmtMs: nowSec, serverReceivedMs: NOW });
  record(
    "raw seconds without normalization would false-trip SEVERE",
    r.severity === "SEVERE",
    `severity=${r.severity} drift=${r.driftSeconds} (this is why normalizeEaEpochToMs exists)`,
  );
}

// 9. Garbage / non-finite epoch normalizes to null (then warns, never blocks).
{
  const norm = normalizeEaEpochToMs(0);
  const r = evaluateClockDrift({ eaGmtMs: norm, serverReceivedMs: NOW });
  record(
    "zero/garbage epoch normalizes to null and warns without block",
    norm === null && r.severity === "WARN" && r.blockLiveTestCycle === false,
    `norm=${norm} severity=${r.severity} block=${r.blockLiveTestCycle}`,
  );
}

const failed = results.filter((r) => !r.pass);
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) process.exit(1);
process.exit(0);
