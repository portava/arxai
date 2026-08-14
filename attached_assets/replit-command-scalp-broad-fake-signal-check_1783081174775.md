# COMMAND — FAKE-SIGNAL CHECK: CAN SCALP/BROAD SCANNER FIRE ON DATA RUBY WITHHOLDS ON? (read-only)

Read this entire command before doing anything. This is a **READ-ONLY** investigation — do NOT edit code, do NOT change gates, do NOT change anything. The user observed: on the SAME symbol with a LIVE feed badge, **Ruby's chart read says "wait for confirmation" (withholds), but the Scalp card and Broad Scanner emit actionable signals.** Question to answer with file:line proof: are the scalp/broad signals FAKE (firing on data that fails the same sufficiency bar Ruby correctly withholds on), or is it HONEST disagreement (they answer a different question that legitimately clears the same bar)? Report the verdict; propose a fix only if a real gap is found — do not apply it.

## WHAT'S ALREADY KNOWN (from source — verify and extend)
- The MAIN opportunity/scanner path DOES gate on sufficiency: `marketScanner.ts` calls `evaluateMarketDataSufficiency` (:1258), neutralizes when `!mayShowConfidence` (:501), and downgrades `LIVE_FEED + insufficient` (:1279) — the same engine that governs Ruby's read. Comments assert pattern/trendline signals "never produce READY_NOW, never override feed/sufficiency caps."
- So the main path is SUPPOSED to be consistent with Ruby. The open question is whether the SCALP path and the BROAD-scan card path route through that SAME neutralization, or bypass it.

## THE CORE QUESTION
Ruby withholds ("wait for confirmation") when its read layer is not FULL — i.e. insufficient CLOSED-bar structure / feed-not-confirmed (`deriveRubyReadLayers` / `rubyStructuralReadService.ts`, STRUCTURAL_ONLY / INSUFFICIENT). For the SAME symbol+timeframe where Ruby withholds:
- Does the SCALP engine emit an actionable signal (a real BUY/SELL scalp setup, "Ready now"/act language)?
- Does the BROAD scanner card emit an actionable signal?
- If YES to either: is that signal derived from data that PASSES `evaluateMarketDataSufficiency` (so it's a legitimately different-but-sufficient read), or does it BYPASS the sufficiency/feed gate (so it's firing on data Ruby correctly withholds → a FAKE/over-confident signal)?

## STEP 1 — TRACE THE SCALP SIGNAL PATH (read-only)
- Locate the scalp engine that produces the scalp card's signal (the scalp result → `ScalpSignalCard`). Find where the scalp BUY/SELL/READY status is COMPUTED (backend).
- Determine what data it reads and what it gates on: does it call `evaluateMarketDataSufficiency` / consume the same `sufficiency` verdict / `resolveSymbolFeedVerdict`, and does it NEUTRALIZE (no READY, no actionable signal) when sufficiency is insufficient or the feed is not confirmed — the SAME way `marketScanner.ts:501/1279` does?
- Or does the scalp path compute its signal independently (its own candle read, its own thresholds) WITHOUT the sufficiency neutralization? Quote the exact gate (or absence of one) with file:line.

## STEP 2 — TRACE THE BROAD-SCAN CARD SIGNAL PATH (read-only)
- The Broad Scan opportunity cards render from the opportunity map. Confirm each row's actionability/READY state passes through the `marketScanner.ts` sufficiency neutralization (:501/:1279) before it can show an actionable signal — OR find a path where a broad card can show a signal without that gate.
- Specifically: can a broad card show "Ready now" / an actionable BUY/SELL on a symbol whose sufficiency is `insufficient` or whose feed is unconfirmed? Quote the gate.

## STEP 3 — COMPARE TO RUBY'S GATE (the reconciliation)
- Ruby withholds based on read layer (not FULL → "wait"). The scanner neutralizes based on `mayShowConfidence` / sufficiency status. Are these the SAME threshold, or can they diverge?
- Key case: a symbol with a LIVE feed but INSUFFICIENT closed-bar history. Ruby → STRUCTURAL_ONLY/INSUFFICIENT → "wait." Does the scalp/broad path ALSO withhold here (consistent), or can it still emit a signal (divergent → the observed contradiction, and potentially a fake signal)?
- Determine which of these it is:
  - **CONSISTENT (honest):** scalp/broad go through the same sufficiency neutralization; if they show a signal while Ruby says "wait," it's because the data actually PASSES sufficiency and Ruby's "wait" is about a different/stricter read (e.g. Ruby needs more for a directional structural read than the scalp engine needs for a valid short-term setup). Explain the legitimate difference.
  - **DIVERGENT (potential fake signal):** the scalp/broad path can emit an actionable signal on data that FAILS the sufficiency/feed gate Ruby withholds on — i.e. it bypasses the neutralization. This is a real honesty gap. Identify the exact bypass (file:line).

## STEP 4 — DATA-SOURCE CHECK (is the signal on REAL live data?)
- For the scalp/broad signal: confirm it's computed from REAL routed candles (`analyzeViaRouter`/`routeCandles`), NOT the simulator (`analyzeMarket`/`marketSimulator`) and NOT an empty-candle default stamped LIVE_FEED (the #790 fix should prevent this — confirm it holds for the scalp path too).
- If any scalp/broad signal traces to simulator data or an empty-candle default presented as a live signal → that's a FAKE signal, report loudly.

## CLASSIFY
- **HONEST DISAGREEMENT:** scalp/broad gate on the same sufficiency; when they signal while Ruby waits, the data passes sufficiency and the difference is legitimate (different read purpose). No fix needed — explain the difference so the UI could optionally clarify it.
- **FAKE SIGNAL / REAL GAP:** scalp and/or broad can emit an actionable signal on insufficient/unconfirmed/simulator/empty-candle data that Ruby correctly withholds on → real honesty bug. Identify the exact gap; propose the fix (route that path through the same sufficiency neutralization) but do NOT apply it.
- **INCONCLUSIVE:** if it can't be determined statically, say what runtime check is needed.

## NON-NEGOTIABLE
- READ-ONLY. No code change, no gate change. Only reads/greps/trace.
- Do NOT weaken any gate. If a gap is found, the FIX direction is to TIGHTEN the scalp/broad path to match Ruby/the sufficiency gate — never to loosen Ruby.
- Report with file:line proof — trace the actual compute path, don't infer from comments.

## FINAL REPORT
- The scalp signal compute path + its gate (does it neutralize on insufficient/unconfirmed like `marketScanner.ts:501/1279`?) with file:line.
- The broad-card signal path + its gate, with file:line.
- The reconciliation vs Ruby's withhold: same threshold or divergent?
- Data-source check: real routed candles vs simulator/empty-default.
- Verdict: HONEST DISAGREEMENT (explain the legitimate difference) or FAKE SIGNAL / REAL GAP (identify the bypass + proposed tightening fix, not applied).

## COMPLETION STANDARD
- A clear verdict, proven with file:line: either the scalp/broad signals are gated by the SAME sufficiency/feed authority as Ruby (honest disagreement — explain why they can differ), OR a specific bypass is identified where scalp/broad emit actionable signals on data Ruby withholds on (fake-signal gap), with a proposed tightening fix left un-applied.
- Data-source confirmed: scalp/broad signals derive from real live candles, not simulator/empty-default presented as live.
- No code/gate change; read-only.
