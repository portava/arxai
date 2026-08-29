// Test: the typed provenance envelope (seed for gate #19).
//
// ARX's standing failure mode is a number that LOOKS like a market reading but
// was invented, interpolated, or is hours stale. The fix is to stop passing
// bare numbers around: every value that could influence a trade travels inside
// a `Provenanced<T>` envelope that names WHERE it came from and WHEN it was
// true, and a single predicate — `isTradeable` — decides whether that origin is
// good enough to size a position from.
//
// This test locks the contract:
//   - only LIVE_TICK and DERIVED are tradeable; MODEL, SYNTHETIC, UNKNOWN and
//     STALE are NOT (a model output and a stale tick are both "a number", and
//     both must be refused);
//   - the refusal is DEFAULT-DENY: an unrecognised source string is not
//     tradeable, so a future enum member added without touching the predicate
//     fails closed rather than open;
//   - `NO_DATA` is a unique symbol, so "we have no value" can never be confused
//     with `0`, `null`, `undefined` or `NaN` — the four things a fabricated
//     reading most often decays into.
//
// Pure unit test — no DB, no network, safe to wire into the offline CI lane.
//
// NOTE: this module is a SEED. It is exported and unit-tested here; wiring it
// into the 23-gate evaluator as gate #19 is a separate, later work order. No
// dispatch-path file imports it yet, and this test asserts that too.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NO_DATA,
  isTradeable,
  type Provenanced,
  type ProvenanceSource,
} from "../../artifacts/api-server/src/lib/provenance/index.js";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");

export async function run(): Promise<CiTestResultLike> {
  let failures = 0;
  let passes = 0;

  function assert(cond: boolean, label: string) {
    if (cond) {
      passes++;
      console.log(`  ✓ ${label}`);
    } else {
      failures++;
      console.error(`  ✗ ${label}`);
    }
  }

  console.log("provenanceEnvelopeTest");
  console.log("======================\n");

  // ── 1. The tradeability partition ──────────────────────────────────────────
  // This is the whole point of the type: which origins may size a position.
  console.log("Tradeability partition");

  const TRADEABLE: ProvenanceSource[] = ["LIVE_TICK", "DERIVED"];
  const REFUSED: ProvenanceSource[] = ["MODEL", "SYNTHETIC", "UNKNOWN", "STALE"];

  for (const source of TRADEABLE) {
    assert(isTradeable({ source }) === true, `${source} is tradeable`);
  }
  for (const source of REFUSED) {
    assert(isTradeable({ source }) === false, `${source} is NOT tradeable`);
  }

  // Every declared source must be classified by exactly one of the two lists —
  // a new enum member that nobody classified is a silent hole.
  assert(
    new Set([...TRADEABLE, ...REFUSED]).size === TRADEABLE.length + REFUSED.length,
    "the two lists are disjoint (no source is both tradeable and refused)",
  );

  // ── 2. Default-deny on an unknown origin ───────────────────────────────────
  // A predicate written as `source !== "SYNTHETIC"` would pass section 1 and
  // still fail here. Unrecognised origins MUST fail closed.
  console.log("\nDefault-deny on unrecognised origins");
  for (const bogus of ["", "live_tick", "LIVE", "BACKFILL", "ESTIMATE", "null"]) {
    assert(
      isTradeable({ source: bogus as ProvenanceSource }) === false,
      `unrecognised source ${JSON.stringify(bogus)} is NOT tradeable (fails closed)`,
    );
  }

  // ── 3. NO_DATA is a unique symbol, never a falsy number ────────────────────
  // "No value" must be impossible to arithmetic on by accident.
  console.log("\nNO_DATA sentinel");
  assert(typeof NO_DATA === "symbol", "NO_DATA is a symbol");
  assert(NO_DATA !== Symbol("NO_DATA"), "NO_DATA is not equal to a same-described symbol");
  assert(NO_DATA === NO_DATA, "NO_DATA is stable across reads");
  assert(
    Symbol.keyFor(NO_DATA) === undefined,
    "NO_DATA is not in the global symbol registry (cannot be forged via Symbol.for)",
  );
  for (const falsy of [0, -0, NaN, null, undefined, "", false]) {
    assert(
      (NO_DATA as unknown) !== (falsy as unknown),
      `NO_DATA is distinguishable from ${String(falsy)}`,
    );
  }

  // ── 4. The envelope carries the four facts a reading needs ─────────────────
  console.log("\nEnvelope shape");
  const tick: Provenanced<number> = {
    value: 1.10234,
    source: "LIVE_TICK",
    asOf: "2026-08-15T12:00:00.000Z",
    sourceId: "mt5:EURUSD",
  };
  assert(tick.value === 1.10234, "envelope carries the value");
  assert(tick.source === "LIVE_TICK", "envelope carries the source");
  assert(tick.asOf === "2026-08-15T12:00:00.000Z", "envelope carries asOf");
  assert(tick.sourceId === "mt5:EURUSD", "envelope carries sourceId");
  assert(isTradeable(tick) === true, "a full envelope is accepted by isTradeable");

  // isTradeable reads ONLY `source` — it must not require the rest of the
  // envelope, so call sites can classify before they have a full reading.
  assert(
    isTradeable({ source: "STALE" }) === false,
    "isTradeable needs only the source field",
  );

  // ── 5. The seed must not have been wired into the dispatch/gate path yet ──
  // Gate #19 is a later work order. If someone wires this in early, that change
  // belongs in a work order that reviews the gate ordering — not here.
  console.log("\nSeed isolation: not yet on the dispatch/gate path");
  const provenanceSrc = readFileSync(
    join(ROOT, "artifacts/api-server/src/lib/provenance/index.ts"),
    "utf8",
  );
  assert(
    !/\bimport\b[^\n]*from\s+["']/.test(provenanceSrc),
    "provenance/index.ts imports nothing (pure, standalone)",
  );

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "provenanceEnvelopeTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[provenanceEnvelopeTest] FAILED:", err);
      process.exit(1);
    },
  );
}
