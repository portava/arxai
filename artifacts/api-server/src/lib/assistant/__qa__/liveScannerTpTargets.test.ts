// Live scanner TP targets — volatility awareness is TIGHTEN-ONLY, and pip
// math is per-symbol truth or an honest null.
//
// Pins, offline (dummy unroutable DATABASE_URL satisfies any lazy
// @workspace/db init in the scanner's import chain; no query is ever issued):
//
//   1. TIGHTEN-ONLY PROPERTY — across a grid of stop distances, ATR
//      projections and expected-range caps, every TP distance WITH the
//      expected-range read is ≤ the same TP distance WITHOUT it, and TP1/TP2
//      (pure R-multiples of the stop) are bit-identical. The read can pull a
//      runner IN; it can never push any target OUT.
//   2. ABSENT IS ABSENT — with no expected-range read the output is
//      byte-identical to the legacy heuristic. No cap is invented.
//   3. PIP HONESTY — distancePips uses the per-symbol pip unit (EURUSD
//      0.0001, JPY-quoted 0.01) and is null when the unit cannot be resolved
//      (synthetics without broker truth) — never the old blanket ×10000.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/assistant/__qa__/liveScannerTpTargets.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";

// The scanner's import chain transitively touches @workspace/db (throws at
// module init without a URL), so the runtime import must be dynamic, after
// the dummy URL is in place — same pattern as featureSnapshot.test.ts.
const { buildTpTargets } = await import("../liveScanner.js");

const NO_EM = { pipSize: null, expectedRunnerRange: null };

function distances(
  built: ReturnType<typeof buildTpTargets>,
): Map<string, number> {
  return new Map(built.targets.map((t) => [t.label, t.distancePoints]));
}

// ── 1. Tighten-only property ────────────────────────────────────────────────

test("expected-range cap can only pull targets IN — grid property", () => {
  const entry = 100_000;
  for (const stopDist of [200, 1000, 2500]) {
    for (const atrMult of [2.5, 4, 6]) {
      const atrProjection = stopDist * atrMult;
      for (const capMult of [0.5, 1, 2, 3.5, 10]) {
        const cap = stopDist * capMult;
        for (const action of ["BUY", "SELL"] as const) {
          const legacy = buildTpTargets(action, entry, stopDist, entry + 5000, entry - 5000, atrProjection, NO_EM);
          const withEm = buildTpTargets(action, entry, stopDist, entry + 5000, entry - 5000, atrProjection, {
            pipSize: null,
            expectedRunnerRange: cap,
          });
          const dLegacy = distances(legacy);
          const dEm = distances(withEm);
          assert.equal(withEm.targets.length, legacy.targets.length);
          for (const [label, dist] of dEm) {
            const base = dLegacy.get(label)!;
            assert.ok(
              dist <= base + 1e-9,
              `${action} ${label} with cap ${capMult}R must not exceed legacy (${dist} > ${base})`,
            );
          }
          // TP1/TP2 are pure R-multiples of the stop — untouched by the read.
          assert.equal(dEm.get("TP1"), dLegacy.get("TP1"));
          assert.equal(dEm.get("TP2"), dLegacy.get("TP2"));
          // The runner never collapses inside 3R (the fallback floor).
          assert.ok(dEm.get("TP3")! >= stopDist * 3 - 1e-9);
        }
      }
    }
  }
});

test("absent expected range ⇒ byte-identical legacy output (no invented cap)", () => {
  const legacyDefault = buildTpTargets("BUY", 1.1, 0.001, 1.105, 1.095, 0.004);
  const explicitAbsent = buildTpTargets("BUY", 1.1, 0.001, 1.105, 1.095, 0.004, NO_EM);
  assert.equal(JSON.stringify(legacyDefault), JSON.stringify(explicitAbsent));
});

test("a cap wider than the heuristic changes nothing (min, not replace)", () => {
  const loose = buildTpTargets("SELL", 500, 10, 520, 480, 40, {
    pipSize: null,
    expectedRunnerRange: 400, // far beyond the 40-point ATR projection
  });
  const legacy = buildTpTargets("SELL", 500, 10, 520, 480, 40, NO_EM);
  assert.equal(JSON.stringify(loose.targets.map((t) => t.price)), JSON.stringify(legacy.targets.map((t) => t.price)));
});

// ── 3. Pip honesty ──────────────────────────────────────────────────────────

test("distancePips is per-symbol pip truth, or an honest null — never ×10000", () => {
  // EURUSD-style: 0.0001 pip. Stop 0.001 ⇒ TP1 distance 0.001 ⇒ 10 pips.
  const fx = buildTpTargets("BUY", 1.1, 0.001, 1.105, 1.095, 0.004, {
    pipSize: 0.0001,
    expectedRunnerRange: null,
  });
  const tp1 = fx.targets.find((t) => t.label === "TP1")!;
  assert.ok(Math.abs((tp1.distancePips ?? 0) - 10) < 1e-9, `TP1 must be 10 pips (got ${tp1.distancePips})`);

  // JPY-style: 0.01 pip. Stop 0.5 ⇒ TP2 distance 1.0 ⇒ 100 pips.
  const jpy = buildTpTargets("SELL", 150, 0.5, 151, 149, 2, {
    pipSize: 0.01,
    expectedRunnerRange: null,
  });
  const tp2 = jpy.targets.find((t) => t.label === "TP2")!;
  assert.ok(Math.abs((tp2.distancePips ?? 0) - 100) < 1e-9, `TP2 must be 100 pips (got ${tp2.distancePips})`);

  // Unresolvable pip unit (synthetic without broker truth): honest null.
  const unknown = buildTpTargets("BUY", 100_000, 1000, 106_000, 94_000, 4000, NO_EM);
  for (const t of unknown.targets) {
    assert.equal(t.distancePips, null, `${t.label} pip distance must be null when the unit is unknown`);
    assert.ok(Number.isFinite(t.distancePoints), "price-unit distance is still served");
  }
});

test("stop-distance refusal is unchanged: no stop, no targets, honest reason", () => {
  const refused = buildTpTargets("BUY", 1.1, 0, 1.105, 1.095, 0.004, {
    pipSize: 0.0001,
    expectedRunnerRange: 0.002,
  });
  assert.equal(refused.targets.length, 0);
  assert.ok(refused.reason && /stop distance unavailable/i.test(refused.reason));
});
