# COMMAND — SCANNER CARD-TEXT DRIFT + EXEC-LABEL CLARIFICATION (display-only, the last cosmetic items)

Read this entire command before changing anything. Two remaining DISPLAY-ONLY scanner honesty items. Neither is a safety/execution issue — no gate, no dispatch, no feed logic, no scoring math changes. These are the residual "the card contradicts itself" and "the label implies more than it measures" items flagged across prior audits (the #601-class hardening). Fix them by binding visible text to the ONE shared verdict, and by honestly labeling the feed-derived Exec value. Do NOT change any execution/trade/gate/feed path. Do NOT invent fake per-symbol variation.

## PART 1 — CARD-TEXT DRIFT: "Ready now" + "Wait for confirmation" cannot co-render

**The bug:** opportunity/scalp cards can show a `Ready now` badge, then a line saying "Wait for confirmation.", then "you can act now" — three contradictory states on ONE card — because the badge, the score color, the CTA, and the guidance line each decide their wording independently instead of from one shared verdict.

**The fix:** every piece of visible card text/badge/CTA/color must derive from the SAME verdict, so contradictory states are impossible by construction.
- Find every scanner card surface that renders actionability wording: the opportunity map card (`BroadScanOpportunityMap.tsx` / the row card), the scalp card (`ScalpSignalCard.tsx`), and the header summary (`ScannerHeaderSummary.tsx`) — anywhere "Ready now / Wait for confirmation / No trade / Watch / act now" strings are produced.
- Route ALL of them through the ONE shared verdict → display mapping (reuse `SCANNER_ACTIONABILITY_UI` / the consolidated actionability verdict / the `scannerTruth` utilities that already exist — do NOT add a parallel label path).
- Requirements (all derive from the same verdict):
  - `Ready now` renders ONLY when the verdict is actionable-now.
  - `Wait for confirmation` renders ONLY when the verdict is confirmation-required.
  - `No trade`/blocked renders for blocked/reject verdicts.
  - The badge, the guidance line, the score color, and the CTA enabled/disabled state ALL agree with that one verdict.
  - A card can NEVER show `Ready now` and `Wait for confirmation` (or "act now" + "wait") simultaneously — make it structurally impossible, not just unlikely.
- Remove the duplicated/independent frontend label logic that currently lets these drift.

## PART 2 — EXEC-LABEL: stop implying per-trade execution quality on a feed-derived number

**The bug:** the "Exec" score is `executionQualityFor(dataSource)` — a switch on FEED STATE (LIVE_FEED→80, LIVE_DELAYED→35, etc.), identical for every symbol on the same feed. It's a real number, but labeling it "Exec" next to a per-symbol "Edge" implies a per-trade execution-quality assessment it does NOT measure. (Confirmed feed-derived, not fabrication — do NOT invent fake per-symbol variation to make it look varied.)

**The fix (honest labeling, not fake data):**
- Relabel/reframe the surfaced value so the user understands it reflects FEED / EXECUTION-READINESS (feed quality/liveness), not a per-trade execution score. Options (pick the cleanest that fits the UI):
  - Rename the visible label from "Exec" to something like "Feed" or "Feed-ready" or "Exec-readiness", OR
  - Keep a short label but tie it visibly to the feed state (so it's clear the number tracks the live/delayed/stale feed), OR
  - Add a tooltip/caption making explicit it reflects feed-execution-readiness.
- Do NOT compute a fake per-symbol exec score. If (and only if) genuine per-symbol execution inputs are already available (real spread, slippage, liquidity), you MAY surface a real per-symbol value from them — but only from REAL data; otherwise honest labeling is the fix.
- Keep the underlying value/behavior the same — this is a LABEL/presentation change so the number isn't misread as something it isn't.

## NON-NEGOTIABLE
- DISPLAY-LAYER ONLY. Do NOT change: the feed verdict, the sufficiency/actionability computation, `executionQualityFor`'s value logic, the scoring math, any gate, any dispatch/execution/trade path, the import-boundary-protected modules.
- Reuse the EXISTING shared verdict/actionability utilities — no parallel label systems or parallel classifiers (a parallel path is what caused the drift).
- No fake per-symbol variation invented for Exec — honest labeling over fake data.
- Do NOT weaken any honesty behavior: stale/insufficient must still read honestly; this makes the card CONSISTENT, it does not force-green anything.

## TESTS / VERIFY
- A render test that a card CANNOT show `Ready now` + `Wait for confirmation` (or "act now" + "wait") at the same time — badge + guidance line + CTA all from the one verdict.
- A render test that `Ready now` only appears for actionable verdicts, `Wait for confirmation` only for confirmation-required, blocked shows no actionable language, stale/insufficient never shows `Ready now`.
- Exec label: confirm the surfaced label/caption reflects feed-readiness (not presented as a fabricated per-symbol execution score); underlying value unchanged.
- Dashboard typecheck green; `ci:guards` green (import-boundary / chart-truth guards still pass — proving no verdict/gate coupling changed); existing scanner-truth/readability suites still pass.

## FINAL REPORT
- Part 1: which card surfaces were routed through the shared verdict, and the removed duplicate label logic; proof a card can't co-render contradictory states.
- Part 2: how the Exec value was relabeled/reframed (and confirmation it's honest-label, not fabricated variation; underlying value unchanged).
- Confirmation NO execution/gate/feed/scoring-math change; guards + typechecks green; scanner-truth/readability suites pass.

## COMPLETION STANDARD
- No scanner card can render `Ready now` and `Wait for confirmation`/"act now"+"wait" simultaneously; badge, guidance, color, and CTA all derive from ONE shared verdict.
- The Exec value is honestly labeled as feed/execution-readiness (or backed by REAL per-symbol inputs) — never implying a per-trade quality it doesn't measure; no fake variation invented; underlying value unchanged.
- DISPLAY-ONLY: no gate/feed/scoring/execution change; existing honesty behavior preserved (nothing force-greened); guards + typechecks + scanner-truth/readability tests green.
