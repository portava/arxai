# COMMAND — DIAGNOSE THE RED `admin-trading-no-live-bypass` GUARD (read-only first, then fix only if real)

Read this entire command before changing anything. A live-execution safety guard (`admin-trading-no-live-bypass`) is currently RED in `ci:guards`. This is the guard protecting the live-trade chokepoint. Two facts are in tension and MUST be reconciled: Task #786 made the adminTrading gate-#8 lock STRUCTURAL and passed **51/51 guards** including this one; now, two tasks later, this same guard is RED. "Known pre-existing" does not explain a guard that was green at #786 and red now. **Do NOT edit any safety gate to make the guard pass. First DIAGNOSE whether this is a flake, a regression, or a tightened-guard-vs-shipped-code gap. Only then, if a real fix is warranted, apply the SMALLEST safe one — and a safety guard's job is to fail loudly, so the fix is almost never "loosen the guard."**

## STEP 0 — REPRODUCE CLEAN (the flake-vs-real test, do this FIRST)

- Check out a CLEAN `main` (no other task in flight, no uncommitted edits — confirm `git status` clean and report the commit SHA).
- Run `pnpm run ci:guards` ALONE (nothing else running — no parallel validation lanes, no concurrent tsc), and capture the FULL output for `admin-trading-no-live-bypass` specifically.
- Run it a SECOND time, alone, to check determinism.
- Classify:
  - **Green both times, alone** → it was validation-saturation/state flake (same pattern as the `meCachedReadEndToEndTest` flake under 5 concurrent lanes). Report this, run it a third time to be sure, and STOP — no code change. The guard is fine; the red was load.
  - **Red (deterministically), alone** → it is REAL. Proceed to Step 1. Do NOT stop at "known."

## STEP 1 — IF DETERMINISTICALLY RED: FIND EXACTLY WHAT IT TRIPS ON (read-only)

- Read the guard itself: `scripts/src/ci/check-*admin-trading*` (or wherever `admin-trading-no-live-bypass` is defined). Determine PRECISELY what it asserts — which files it scans, which pattern/symbol it forbids, and what condition flips it red.
- Read the files it scans — `lib/adminTrading/orderGuard.ts` (gate #8, the #786 structural lock), `brokerPlacement.ts`, and every `mt5_commands` mailbox writer the guard covers.
- Answer the decisive question: WHAT, in the scanned files, does the guard now object to? Quote the exact line(s) the guard flags and the exact guard assertion that fires. The gap between "what the guard expects" and "what's in the file" IS the diagnosis.
- Determine WHICH of these it is (report which, with evidence):
  - **(a) Guard was added/tightened after #786** to expect a stronger invariant than #786 shipped — so #786's structural lock is correct but incomplete vs the new guard's expectation. (Check git history/blame on the guard file: was it changed after #786 merged?)
  - **(b) Something regressed between #786 and now** — a later change reintroduced an env-read, a new mailbox writer, or a new `placeOrder`/`dispatchToBroker` path the guard correctly catches. (Check what changed in `adminTrading/` and the mailbox writers since #786.)
  - **(c) The guard's own logic is stale/incorrect** — it's flagging something that is actually safe (e.g. it greps for a string that now appears in a comment or a structurally-locked path). Only conclude this with strong proof, since the safe default is to trust a safety guard.

## STEP 2 — FIX (only if Step 1 confirms real; smallest safe change for the actual cause)

Apply the fix that matches the diagnosed cause — NEVER weaken the guard or a gate to silence it:
- **If (a) tightened guard, shipped code incomplete:** make the code satisfy the stronger invariant the guard now demands (e.g. if the guard wants NO mailbox write reachable outside Phase B, make the adminTrading path structurally unable to write the mailbox at all, not just gate-denied). This is a TIGHTENING of the live-execution path — the safe direction.
- **If (b) regression:** revert/repair the specific change that reintroduced the bypass surface. Restore the structural lock the guard is correctly protecting.
- **If (c) genuinely stale guard logic (rare, prove it):** fix the GUARD to assert the real invariant precisely (not loosen it — make it correct), so it stops flagging the safe pattern while STILL catching a real bypass. If you conclude (c), the report must show why the flagged pattern is provably safe AND that the corrected guard still fails on a real injected bypass (test it by temporarily adding a fake direct mailbox write and confirming the guard catches it).

## NON-NEGOTIABLE
- This is the LIVE-EXECUTION chokepoint guard. Do NOT loosen it, comment it out, add an exception/allowlist for `adminTrading`, or weaken gate #8 to make it green. The only acceptable outcomes are: (1) proven flake → no change; (2) code tightened to satisfy the invariant; (3) guard made MORE correct (still catches real bypasses, proven by injecting one).
- No change to the Phase B 23-gate, synthetic floor, SL policy, or any unrelated path.
- If at any point the fix would involve relaxing what can reach `dispatchToBroker`/`mt5_commands`, STOP — that is the wrong direction.

## VERIFY
- `pnpm run ci:guards` green (all guards, including `admin-trading-no-live-bypass`) — run ALONE, paste full output.
- If you touched `orderGuard.ts` or the adminTrading path: re-run the phase35 routing tests + api-server typecheck (the #786 lockstep suite) and confirm DEMO still routes to the demo queue and LIVE still hard-denies to Phase B.
- If (c) and you edited the guard: paste proof the corrected guard STILL catches a real bypass (inject a fake direct `mt5_commands` OPEN write, show the guard goes red, then remove it).
- Confirm `git status` clean / diff is only the intended files.

## FINAL REPORT
- Step 0 result: clean-main SHA + the two (or three) isolated `ci:guards` runs for `admin-trading-no-live-bypass` → flake or deterministically red.
- If real: the exact guard assertion + the exact scanned-file line it flags (the diagnosis), and which of (a)/(b)/(c) it is with git-history evidence.
- What was changed (if anything) and why it's a tightening, not a loosening.
- Verification output (guards green, alone; #786 lockstep still green if touched; injected-bypass proof if guard edited).
- Confirmation no gate/floor/SL/Phase-B path was weakened.

## COMPLETION STANDARD — all must be true
- The red is RESOLVED with its cause NAMED (flake / regression / stale-guard), proven — not labeled "known" and skipped.
- If flake: demonstrated green when run alone (≥2x), no code change.
- If real: fixed by TIGHTENING the code or CORRECTING the guard — never by loosening the guard or any gate; the live-execution path is at least as locked as before.
- `ci:guards` green run ALONE (full output pasted); #786 structural lock intact (DEMO→demo queue, LIVE→Phase B hard-deny still proven if the path was touched).
- No Phase-B/floor/SL/unrelated change; diff limited to the intended file(s).
