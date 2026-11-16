// T033 Phase 10 — capability gating decision-rule test.
//
// The hook's `can()` and `needsEaUpdate` are pure decisions over the bridge
// payload; this pins those rules (default-deny, pre-v1.50 handling) without a
// browser/React-Query runtime. If useLiveCapabilities's logic changes, update
// both.

type CheckResult = { id: number; name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];
function record(id: number, name: string, ok: boolean, detail: string) {
  results.push({ id, name, ok, detail });
}

// Mirror of the hook's decision logic.
function decide(bridge: {
  eaVersion?: string | null;
  capabilities?: Record<string, boolean> | null;
  capabilityMeta?: { v150Aware?: boolean; eaVersion?: string | null };
} | null) {
  const caps = bridge?.capabilities ?? null;
  const eaVersion = bridge?.capabilityMeta?.eaVersion ?? bridge?.eaVersion ?? null;
  const v150Aware = bridge?.capabilityMeta?.v150Aware ?? (caps !== null);
  const needsEaUpdate = bridge !== null && !!eaVersion && !v150Aware;
  const can = (key: string) => caps != null && caps[key] === true;
  return { caps, eaVersion, needsEaUpdate, can };
}

// 1. Explicit true → can = true.
const d1 = decide({ eaVersion: "1.50", capabilities: { supportsTrailingStop: true, supportsPartialClose: false }, capabilityMeta: { v150Aware: true, eaVersion: "1.50" } });
record(1, "explicit true enables action", d1.can("supportsTrailingStop") === true, String(d1.can("supportsTrailingStop")));

// 2. Explicit false → can = false (hide).
record(2, "explicit false hides action", d1.can("supportsPartialClose") === false, String(d1.can("supportsPartialClose")));

// 3. DEFAULT-DENY: missing key → can = false (never enable from absence).
record(3, "missing key → default-deny false", d1.can("supportsReverse") === false, String(d1.can("supportsReverse")));

// 4. Pre-v1.50 EA (capabilities null) → can = false for everything.
const d4 = decide({ eaVersion: "1.29", capabilities: null, capabilityMeta: { v150Aware: false, eaVersion: "1.29" } });
record(4, "pre-v1.50 → all caps false", d4.can("supportsMarketOrders") === false && d4.can("supportsTrailingStop") === false, "");

// 5. Pre-v1.50 EA attached → needsEaUpdate true.
record(5, "pre-v1.50 attached → needsEaUpdate", d4.needsEaUpdate === true, String(d4.needsEaUpdate));

// 6. v1.50 EA → needsEaUpdate false.
record(6, "v1.50 EA → no update nag", d1.needsEaUpdate === false, String(d1.needsEaUpdate));

// 7. No bridge at all → needsEaUpdate false (don't nag when nothing attached).
const d7 = decide(null);
record(7, "no bridge → no update nag", d7.needsEaUpdate === false && d7.can("supportsMarketOrders") === false, "");

// 8. Bridge present but no eaVersion → no update nag (can't assert it's old).
const d8 = decide({ eaVersion: null, capabilities: null });
record(8, "bridge w/o version → no nag", d8.needsEaUpdate === false, String(d8.needsEaUpdate));

// 9. capabilityMeta.v150Aware true but caps present → can still default-denies unknowns.
const d9 = decide({ eaVersion: "1.50", capabilities: { supportsValidateOnly: true }, capabilityMeta: { v150Aware: true } });
record(9, "v150-aware still default-denies unknown", d9.can("supportsValidateOnly") === true && d9.can("supportsRemoteConfig") === false, "");

// 10. A non-boolean (corrupt) value → not enabled (=== true is strict).
const d10 = decide({ eaVersion: "1.50", capabilities: { supportsReverse: 1 as unknown as boolean }, capabilityMeta: { v150Aware: true } });
record(10, "non-boolean cap value not enabled", d10.can("supportsReverse") === false, String(d10.can("supportsReverse")));

// ─── tally ───
const passed = results.filter((r) => r.ok).length;
for (const r of results) {
  // eslint-disable-next-line no-console
  console.log(`${r.ok ? "PASS" : "FAIL"}  #${String(r.id).padStart(2, "0")}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
}
// eslint-disable-next-line no-console
console.log(`\n${passed}/${results.length} capability-gating checks passed`);
if (passed !== results.length) process.exit(1);

export {};
