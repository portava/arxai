---
name: runTest-in-notebook can be reaped mid-run
description: How to detect/diagnose code_execution notebook dying during a long runTest, and the durable substitute deliverable
---

# runTest-inside-code_execution can die mid-run; persist its result to a file

The browser-driven `runTest` (testing skill) is invoked from the `code_execution`
notebook. In an unstable session the notebook worker can be **reaped during the
long-running runTest call, before it returns** — surfacing as "worker
disconnected", "cancelled by server", or "executed successfully with EMPTY
stdout, then notebook not found / auto-restarted" on the next call. The captured
`result` is lost and notebook variables are gone after restart.

**Diagnostic technique (proves mid-run death vs transient flake):** before
calling runTest, write a sentinel file (`phase:"starting"`) to a shared path
(e.g. `.local/state/<task>_runtest_result.json`) with `fs.writeFileSync`, then
overwrite it with the real result the instant runTest returns. Read it back with
the file tool regardless of notebook state.
- File still says `phase:"starting"` ⇒ runTest never returned (notebook reaped
  mid-run) — environment block, NOT a test failure.
- A trivial probe (`1+1`) succeeding afterward proves the notebook recovers for
  SHORT calls but cannot survive a full runTest in that session.

**Why:** repeated infra deaths look like test failures but aren't; the sentinel
file disambiguates and stops you from re-spamming a deterministically blocked
call.

**Durable substitute when runTest is blocked:** deliver a committed deterministic
jsdom render-proof of the exact interactive surface the e2e would exercise (this
repo's standard pattern), and verify the REAL-backend half is already locked by a
DB-backed route suite. Together they cover the e2e's assertions across layers
without depending on the flaky browser path. File a follow-up to add the true
page-level/browser e2e once infra is healthy. (Concrete case: Admin Cockpit
operator controls — `cockpitShared.interaction.test.tsx` locks ReasonDialog
reason-gate + MaskedValue; `adminCockpitRoute.test.ts` locks reason>=3 / OWNER
masking / audit rows.)
