---
name: Command integrity source allowlist must enumerate every live source
description: The integrity pre-gate's route allowlist blocks any live command whose stamped sourcePage isn't listed; missing a real source silently breaks a live path.
---

The command-integrity pre-gate (runs BEFORE the 16-gate in dispatchLiveCommand)
checks `row.sourcePage` against `ALLOWED_SOURCE_PREFIXES` in
`artifacts/api-server/src/lib/security/commandIntegrity.ts`. A source not on the
list → `INTEGRITY_ROUTE_NOT_ALLOWED` → LIVE_BLOCKED. This is default-deny by design,
so the allowlist is a hard dependency on EVERY server path that stamps a live command.

**Why:** advisory-additive layers that default-deny are easy to ship "green" while
silently blocking real flows — unit tests on the pure verdict pass, but legitimate
dispatch breaks. Two code-review rounds were needed because the first allowlist
omitted ONE_CLICK, TRADES_LIVE_SHARED_*, LIVE_TEST_CYCLE_ suffixes,
ADMIN_EMERGENCY_CLOSE, and ADMIN_ORPHAN_CLOSE.

**How to apply:** sources are stamped two ways — direct `sourcePage: "..."` literals,
AND indirectly via wrappers (currently only `runEmergencyClose(scope, "ADMIN_*")` in
emergencyClose.ts, called from adminBridgeControl.ts). When adding a new live
entrypoint, register its source. The contract guard test in
`__qa__/commandIntegrity.test.ts` ("every stamped sourcePage literal is in the route
allowlist") scans both patterns and fails on drift — but it only sees string
literals, NOT template/dynamic sources, so a dynamically-computed source can still
slip past the guard. Keep exact entries tight (no broad `ADMIN_` wildcard) so a
tamperer can't pick an arbitrary in-prefix source.
