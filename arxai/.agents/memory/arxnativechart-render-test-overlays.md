---
name: ARXNativeChart render-test infinite-loop trap
description: Rendering ARXNativeChart under jsdom/testing-library needs a STABLE overlays reference or it infinite-renders.
---

Rendering `ARXNativeChart` in a vitest/testing-library render test will hang in
an infinite render loop unless you pass a **stable** `overlays` reference
(module-level `const NO_OVERLAYS = []`), not the inline `[]` default.

**Why:** the P/L-bubble effect depends on `overlays` and calls `setBubbles([])`
when there are no P/L overlays. The component's `overlays` prop default is a
fresh `[]` each render, so the effect re-runs every render → setBubbles → new
default `[]` → effect again → infinite. In production the parent passes a
memoized overlays prop, so it never loops there.

**How to apply:** any render/integration test of ARXNativeChart (or similar
components with an effect that depends on an array/object prop AND setStates)
must pass a stable reference for that prop. Symptom is a hang with only `RUN`
printed and no test results (loop is during render, before the reporter
summary), and `timeout` killing vitest with EXIT=124 (vitest traps SIGTERM so
the inner `timeout` may need SIGKILL).

Test-running note in this env: run a single vitest file via
`node --max-old-space-size=3072 ./node_modules/vitest/vitest.mjs run <file>`
from the artifact dir; plain `pnpm exec vitest` OOMs/no-output and
`--reporter=basic` is invalid in vitest 4.
