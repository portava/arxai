# COMMAND — FIX THE COLD-START "WAIT FOR CONFIRMATION" DEFAULT ON SYMBOL SWITCH (display-only)

Read this entire command before changing anything. Confirmed bug (operator-observed + reproducible): when switching symbols, the scanner actionability badge shows **"Wait for confirmation" INSTANTLY** — before the new symbol's verdict could possibly have been computed. `WAIT_FOR_CONFIRMATION` is a SEMANTIC verdict ("live data is confirmed, but the setup still needs to confirm" — `scannerActionability.ts:257`). Showing it as a **cold-start placeholder** for an un-evaluated symbol is dishonest: the system is asserting a trading state it hasn't computed. The fix: while the verdict for the CURRENT symbol+timeframe is pending/unknown, show a neutral loading state ("Checking…"), never a semantic verdict. **Display-only. Do NOT change the verdict computation, any gate, sufficiency, or actionability logic — only what renders while the verdict is unknown.**

## THE BUG (verify, then fix)
1. Reproduce/trace: on symbol switch, what does the actionability badge render BEFORE the new symbol's verdict arrives? Find the default/fallback that yields `WAIT_FOR_CONFIRMATION` (candidates: an initial state defaulting to it; the verdict computed from absent/empty inputs falling through to it; or a stale prior-symbol verdict rendering under the new symbol before the keyed store updates).
2. Identify exactly which it is (file:line): initial-state default, empty-input fallthrough, or stale-key flash. Report before fixing.

## THE FIX
- Introduce (or reuse, if one exists) an explicit **pending/unknown** display state for actionability: while no verdict has been computed FOR THE CURRENT symbol+timeframe, the badge renders a neutral "Checking…" (muted tone, `canAct: false`, no directional/setup language) — NOT `WAIT_FOR_CONFIRMATION`, not any semantic verdict.
- The semantic verdict (READY_NOW / WAIT_FOR_CONFIRMATION / NO_CLEAN_SETUP / etc.) renders ONLY once the verdict for the current symbol+timeframe has actually been computed/received.
- Symbol/timeframe switch must NOT flash the PREVIOUS symbol's verdict — the keyed state (already symbol+timeframe-keyed from prior work) must reset to pending on key change until the new verdict lands.
- `canAct` must be false in the pending state (it should already be, but assert it) — no trade affordance enables on an unknown verdict.
- Apply consistently everywhere the actionability badge renders (opportunity card, scalp card, header summary) — they all consume `SCANNER_ACTIONABILITY_UI`; add the pending state at that shared layer so all surfaces get it, not per-component hacks.

## OPTIONAL PART 2 — LABEL CLARITY (do only if trivial; skip if it widens scope)
"Wait for confirmation" reads like a DATA/feed problem, but it means the SETUP hasn't confirmed (the copy already says "live data is confirmed, but…"). If a one-string change is clean, consider a clearer badge label (e.g. "Awaiting setup confirmation" or "Setup not confirmed") — keep the copy line as-is. Do NOT rename the underlying `WAIT_FOR_CONFIRMATION` status enum (too many consumers); label/display string only. If any test/consumer asserts the exact label string, update those test strings — nothing behavioral. Skip this part entirely if it's not a clean one-liner.

## NON-NEGOTIABLE
- DISPLAY-ONLY. Do NOT change: the actionability verdict computation, `resolveScannerActionability`, sufficiency, feed verdicts, any gate, `canAct` semantics for real verdicts, or any execution path.
- The pending state is HONEST-NEUTRAL ("Checking…"), never a semantic verdict, never actionable.
- No parallel state systems — add pending at the shared `SCANNER_ACTIONABILITY_UI` / consuming-hook layer so all surfaces inherit it.
- Real verdicts render exactly as before once computed — this changes only the un-computed window.

## TESTS
- On symbol (and timeframe) switch: the badge shows the pending/"Checking…" state — NOT `WAIT_FOR_CONFIRMATION` or any semantic verdict — until the new symbol's verdict arrives; then the real verdict renders.
- No stale prior-symbol verdict renders after a key change.
- Pending state has `canAct: false` (no trade affordance).
- Existing actionability render tests (incl. the "Ready now + Wait for confirmation can never co-render" proof) still pass unchanged.
- Dashboard typecheck green; `ci:guards` green.

## FINAL REPORT
- Which cold-start mechanism it was (initial default / empty fallthrough / stale-key flash), file:line.
- The pending state added at the shared layer + the surfaces that inherit it.
- Whether Part 2 (label) was done or skipped.
- Test results; confirmation no verdict/gate/actionability-logic change.

## COMPLETION STANDARD
- Switching symbols never shows a semantic verdict before the new symbol's verdict is computed — a neutral "Checking…" renders in the gap, with no trade affordance.
- No stale prior-symbol verdict flash; real verdicts unchanged once computed.
- Display-only diff at the shared actionability layer; existing render proofs still pass; typecheck + guards green.
