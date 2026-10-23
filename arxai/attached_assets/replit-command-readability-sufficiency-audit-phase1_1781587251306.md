# COMMAND — READABILITY / SUFFICIENCY AUDIT (PHASE 1: READ-ONLY INVENTORY, STOP FOR APPROVAL)

Read this entire command before doing anything. This is a **READ-ONLY AUDIT**. Do NOT patch, refactor, backfill feeds, or change scanner / Ruby / chart / trade-ticket / backtest behavior. The deliverable is an inventory + classification + a Phase-2 plan. **Stop after the report and wait for approval before any code change.** Read LIVE source.

## WHY THIS AUDIT EXISTS

Across four separate fixes, the same bug class keeps recurring: two surfaces read the same market and present it differently — one shows a confident read, the other withholds — because each surface has its OWN logic for "is this data readable / how do I present insufficient." Phase 1 of the sufficiency work unified the VERDICT INPUT (`evaluateMarketDataSufficiency`), but each surface still decides its own OUTPUT behavior. The most recent proof: **the scanner shows "bearish" from 1 closed candle while Ruby correctly withholds** — same insufficient verdict, two presentations. This audit finds EVERY such independent decision so Phase 2 can route them all through ONE shared presentational contract and make the contradiction impossible by construction.

## THE ANCHOR BUG (confirmed by prior diagnosis — use as the reference case)

Runtime probe showed EURUSD = 1 closed bar (insufficient, 1/5) while V75 = 299 (sufficient). Both surfaces ARE wired to the engine. The contradiction is a PRESENTATION ASYMMETRY on the same verdict:
- **Scanner** (`marketScanner.ts` ~L420, L1005): on `!canShowTradeSetup` it downgrades the row (label → WAIT_FOR_CONFIRMATION) BUT still emits a directional bias ("bearish").
- **Ruby** (`rubyChartContext.ts`): on insufficient it sets `basis = INSUFFICIENT` and withholds the directional read entirely.
- **Residual**: the legacy "cannot verify chart data" string (`meAssistant.ts` ~L664) survives on the `partial` branch (Phase-1 override maps the engine `humanReason` for `insufficient|blocked` only, NOT `partial`) or when the context builder throws.

The audit must find every OTHER place with this shape, not just these three.

## WHAT TO INVENTORY

Every place — backend or frontend — that independently DECIDES or PRESENTS any of: readable / insufficient / partial / stale / degraded / feed-unavailable / analysis-only / bullish / bearish / neutral / buy / sell / trend direction / confidence / "AI usable" / candle-count sufficiency / scanner-score sufficiency / Ruby-read sufficiency / chart-badge sufficiency / trade-ticket recommendation / backtest eligibility-or-readability.

Layers to search (not exhaustive — follow the code):
1. Scanner rows / cards / header / details (and the per-row `dataStatus`/label/bias derivation).
2. Scanner chart panel + chart overlays.
3. Ruby market-read branches + response builders (`rubyChartContext`, `meAssistant` read-chart, `RubyMarketReadCard`, the read gate hooks).
4. Chart empty states, badges, status labels, overlays, indicator summaries, the feed-status → quality mappers.
5. Trade-ticket preview / recommendation / "suggested direction" panels.
6. Backtest preview / results / eligibility / reliability displays.
7. Watchlist, focus scan, broad scan, scalp, and any mobile-specific card rendering.
8. API response mappers + frontend adapters that convert raw/partial data into bullish/bearish/neutral or a confidence number.
9. Feed-router freshness/status mappers (`freshness.ts`, the per-symbol verdict, the chart feed-status).
10. Any mock / test / story / demo / fixture that still EXPECTS a directional bias when bar count is below the shared minimum (these encode the bad behavior and must be found).
11. Any legacy/dead helper that still EXPORTS readability/bias/sufficiency logic (even if you think it's unused — confirm).

Use grep across the repo for the tell-tale tokens: `bullish|bearish|neutral`, `BUY|SELL`, `confidence`, `INSUFFICIENT|insufficient`, `partial`, `stale`, `aiUsable|AI usable`, `canShowTradeSetup|canShowBuySell`, `WAIT_FOR_CONFIRMATION`, `cannot verify|syncing|unavailable`, `MIN_FLAG_BARS|MIN_SUFFICIENT`, `dataStatus|dataSource`, `bias`, `direction|trend`. Trace each hit to the function that owns the decision.

## FOR EACH FINDING, REPORT

- **File path** + **function/component/hook name**.
- **What decision it makes** (e.g. "derives bullish/bearish from candle slope", "maps feed quality to a badge", "gates the BUY button").
- **What inputs it uses** (candle count? score? quote freshness? the shared verdict? its own threshold?).
- **Does it consume the shared sufficiency verdict** (`evaluateMarketDataSufficiency` / the Phase-1 output), yes/no.
- **Can it display bias/direction/confidence from INSUFFICIENT or PARTIAL data?** yes/no — this is the critical column.
- **Which surface(s) it affects** (scanner / Ruby / chart / trade-ticket / backtest / other).
- **Classification:**
  - **A** — already safe / consumes the shared contract.
  - **B** — needs an adapter to the shared contract (close, just not wired).
  - **C** — UNSAFE duplicate logic (independently infers readable/bias — the bug class).
  - **D** — stale/dead legacy path (exports the logic but nothing live consumes it — candidate for quarantine).
  - **E** — unclear / needs manual review.

## REQUIRED OUTPUT FORMAT

1. **Executive summary** — how many surfaces total, how many are class C (unsafe), and the one-paragraph shape of the problem.
2. **Root cause of the scanner-vs-Ruby contradiction** — confirm/refine the anchor analysis above against live source (the exact lines where the scanner emits bias on insufficient and where Ruby withholds).
3. **Full inventory table** — every finding with all the columns above.
4. **Highest-risk unsafe duplicate logic** — the class-C findings ranked by how likely they are to show a confident/directional read on bad data (scanner bias first, since that's the proven one).
5. **Recommended Phase-2 patch order** — which surfaces to rewire first (highest-risk + lowest-blast-radius first), and where the ONE shared presentational contract should live (propose: a backend-owned presentation verdict that extends the existing engine output with explicit display flags like `mayShowDirection`/`mayShowConfidence`/`mayShowBias` + a single reason string — but recommend based on what the inventory actually shows; if purely-frontend badges need a client helper too, say so).
6. **Exact files that must change in Phase 2** — the concrete list, so Phase 2 is scoped to a known set, not discovered-while-editing.
7. **Regression tests to add in Phase 2** — at minimum: 0 bars → no bias on ANY surface; 1 bar → no bias on ANY surface; <MIN bars → no bullish/bearish/buy/sell/confidence anywhere; Ruby and scanner show the SAME insufficient/partial reason; chart badge shows no direction when insufficient; trade-ticket/backtest surface no direction from insufficient data; and the DIRECT anchor regression — a symbol with exactly 1 bar: scanner must NOT show bearish, Ruby withholds, both show the same shared reason.
8. **Areas intentionally not touched and why** (e.g. the live execution gates — the sufficiency contract is display-only and must never grant trade eligibility; existing live gates remain final).

## CONSTRAINTS ON THE AUDIT ITSELF

- **Read-only.** No edits, no refactor, no feed backfill, no behavior change. If you need runtime evidence (like the bar counts), a read-only probe (mint+delete an ephemeral session, GET-only endpoints, no writes) is fine — but change no product code.
- **Do NOT propose backfilling EURUSD as the fix.** Backfill hides the contradiction; it does not remove the duplicate presentation logic. The audit's job is to find the logic, not the symptom.
- The shared contract, when Phase 2 builds it, must be DISPLAY-ONLY — it can only block/downgrade what a surface shows; it must NEVER grant live-trade eligibility. Note any place where readability logic is entangled with execution permission so Phase 2 keeps them separate.

## PASS CONDITION (Phase 1)

Do not pass until the report answers, concretely and with file/line evidence:

> "Where can the app still show bullish / bearish / buy / sell / trend / confidence from INSUFFICIENT or PARTIAL market data, and what exact files must be patched in Phase 2 to make that impossible?"

**Then STOP. Do not patch. Wait for approval on the inventory + Phase-2 plan before any code change.**
