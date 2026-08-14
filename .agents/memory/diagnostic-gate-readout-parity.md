---
name: Admin diagnostic readouts must mirror the real gate's normalization
description: An admin gate-diagnostic row that re-implements a gate check can drift from the real evaluator and show FAIL while the real gate PASSes (or vice versa).
---

Rule: any admin "gate diagnostic" row that re-derives a pass/fail must use the
SAME normalization as the real enforcement path it claims to report on. They are
two implementations of one check, so they drift silently.

Concrete instance: the live dispatch gate #6 in `livePhaseBDispatchGate.ts`
normalizes `bridgeAccountType` with `.toLowerCase()` and accepts `live`/`real`.
The admin diagnostic (`adminLiveGatesDiagnostic.ts`) originally compared
case-sensitively (`=== "LIVE" || "REAL"`), so for the EA's lowercase `"live"` it
showed **FAIL** while the real gate **PASSED**. Pure display bug — looked like a
real readiness blocker. Fix: normalize identically (`.trim().toLowerCase()`).

**Why:** operators (and you, debugging) trust the diagnostic. A false FAIL sends
you hunting a non-existent broker/EA problem; a false PASS hides a real one.

**How to apply:** when you touch a gate's accept/reject logic, grep the
diagnostic/readout layer for a parallel re-implementation and update both. The
real evaluator is the source of truth; the diagnostic must conform to it, never
the reverse. The existing `test:live-phaseB` truth table locks the gate side
(lowercase `"live"` baseline PASSes; `"demo"` → BRIDGE_NOT_LIVE_ACCOUNT).
