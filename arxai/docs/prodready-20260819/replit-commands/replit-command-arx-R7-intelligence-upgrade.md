# Replit command — R7: intelligence-system upgrade (the judgment + the plan)

**Prerequisite:** R1 merged (it restored the research packages and killed the worst fabrication paths). Run after or alongside R2–R4. Branch + owner merge.

Companion reports: `audit-reports/intel-engine.md` (grades + 7-phase plan) and `audit-reports/intel-learning.md` (closed-loop analysis + 7 steps).

## The judgment (executive summary)

The intelligence system is two systems. The **honesty layer is production-grade** (scanner truth caps, sufficiency verdicts, setup withholding: B+). The **brain is demo-grade**: all 7 strategies are uncalibrated single-timeframe indicator thresholds with confidence numerology (D+); the "AI Brain" is a 30-bar drift detector with hardcoded R:R 2.0 (D); there is no probability/expectancy engine, no edge library, no calibrated anything in the pre-trade path (F vs the vision's SIGNAL layer). Five regime classifiers coexist while the correct hysteresis state machine sits as dead code. Shadow validation measured a random-number generator (fixed in R1: synthetic signal persistence removed; full fix below). The research stack (pre-registration, FDR, CPCV, deflated Sharpe, PBO) is excellently designed, restored by R1, and wired to nothing.

The best trading-intelligence upgrade available is not a new model — it is **connecting the validation machinery to real data and letting WAIT be the default**, exactly as the vision doc demands.

Instruction for Claude Code in the Replit shell:

---

Implement the intelligence upgrade from `intel-engine.md` + `intel-learning.md` on branch `feat/intelligence-upgrade`, in this order:

1. **Kill remaining fabrication feeds** — retire `generateSyntheticCandles` consumers one by one (shadow scan → real candles via the router's decision-grade mode from R4, honest skip when insufficient; `paperIntelligence` PRNG candles + live-balance sizing → real bars or WAIT; `brain/marketBrain` synthetic default → refuse without real data; macro/news fabricated tables → the real economic-calendar seam that already exists). The `check-no-fabrication` guard (restored in R1) ratchets each removal.
2. **Shadow durability** — re-home `lib/shadowPersistence.ts` into `api-server/src/lib/`, wire `persistShadowDecision`/`updateShadowOutcome` into shadow mode, feeding the permanently-empty `shadow_predictions` table. This single change unblocks the learning-model-version gates (deadlocked on shadow sample = 0 forever).
3. **One market-state authority** — wire the dormant hysteresis state machine (`lib/domain/src/market-state/marketStateMachine.engine.ts`) as the single regime classifier; the other four become consumers or die. `UNKNOWN` regime ⇒ scanner withholds, missions WAIT.
4. **Shared feature engine** — one versioned feature snapshot (returns, directional efficiency, volatility, compression) computed identically for scanner, shadow, and research, using `lib/features` (restored) with its point-in-time reader and `LookaheadError`.
5. **Probability/expectancy engine** — calibrated P(target-before-stop) from the durable shadow + closed-trade record, with spread/cost model and a conservative-EV lower bound; scanner opportunity scores replace the double-counted pseudo-factors; conservative EV ≤ 0 ⇒ WAIT. Calibration verified against outcomes (the rubyQuality outcome worker pattern, grade A-, is the template).
6. **Edge library + promotion spine** — edge contracts pre-registered via `lib/discovery` (hash before results), validated via `lib/validation` (CPCV/DSR/PBO/FDR) over real recorded data, promoted through the restored `learning_model_versions` gates: research → shadow (real, durable) → demo → owner-pressed live. Replace the toy replay stand-in with replay of the production decision path, version-pinned (`intel-learning.md` step list).
7. **Strategy engine honesty** — until edges pass validation, the 7 strategies are labeled ADVISORY-UNCALIBRATED in every serving payload; fix the dead confidence terms the audit lists; the `ema20`-named EMA-10 bug; BOS stop geometry.

Hard rules: deterministic risk outranks all of this forever; nothing here touches dispatch gates; every phase lands with tests; WAIT/zero-trades is a success state, not a failure state.

---

**Hold points:** after step 2 (verify shadow rows accumulate on Replit), and after step 5 (owner reviews the first calibration report before any edge promotion).
