---
name: CI validation saturation kills the browser/runTest substrate
description: Why runTest "browser closed unexpectedly" in this env, and the correct lever to get a quiet window
---

# CI validation load OOM-kills runTest's browser (and api-server, and the code_execution notebook)

Symptom: `runTest` returns STATUS:unable with "browser closed unexpectedly" /
`browser.newContext` failure, intermittently, even with a correct plan. Same
load also 502s api-server and reaps the `code_execution` notebook mid-call.

**Root cause:** the registered **validation commands** (`full-ci` =
`pnpm run ci` at ~2.5GB heap running a 390s typecheck + 200+ tests, plus
`safety-integration`) saturate the 8GB box. They are `isValidation = true`
entries (NOT in the View's "Configured Workflows" list — those are the 3
artifact services). When a validation run is active, available memory drops to
<100MB and chromium can't allocate a context.

**The correct lever — get a quiet window:**
`clearValidationCommand({name})` for the heavy ones (`full-ci`,
`safety-integration`, `typecheck`, `targeted-tests`, `ci-guards`), run the
browser test, then **restore with `setValidationCommand({name, command})`**.

**Trap I hit (do not repeat):** I used `removeWorkflow` + `configureWorkflow`
to stop/restore them. `configureWorkflow` recreates them as regular
**autostart** workflows and **drops the `isValidation = true` metadata**
(replacing it with `outputType`), which (a) made them auto-run/"respawn" and
(b) silently de-registered them as validation steps. Fix was to `removeWorkflow`
the bogus regular workflows and `setValidationCommand` to re-register. Use the
**validation skill** for validation steps, the **workflows skill** only for the
3 real service workflows.

**How to apply:** before a browser `runTest` in this repo, if it returns
unable/`browser closed`, check `free -m` (available <~300MB ⇒ saturated) and
`getValidationCommands()`; clear the heavy validation commands, restart
api-server, run the test in the quiet window, then `setValidationCommand` them
back. Verify `.replit` still has `runButton = "Project"` and each restored entry
keeps `isValidation = true` (cosmetic block reordering is fine).
