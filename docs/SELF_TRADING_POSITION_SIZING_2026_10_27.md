# Self-trading position sizing — 2026-10-27

This audit covers how the self-trading entry path turns a risk budget into a lot size: `lib/domain/src/self-trade/riskAwareLotSizer.ts`, `quotaPressure.ts` and the sizing block in `artifacts/api-server/src/lib/selfTrade/agentExecutor.ts`. It changes sizing correctness only. It does not touch strategy, profitability, broker authorization, schema or deployment. Trading stays disabled. No broker, demo or network order was used, and no profitability claim is made.

## Baseline defects (5767ec5)

| # | Where | Repro | Effect |
| --- | --- | --- | --- |
| 1 | `riskAwareLotSizer.ts` `roundToStep` (`toFixed(round(-log10(step)))`) | step 0.5, raw 1.6 lots (budget $800, riskPerLot $500) | Returned **2.0**, so risk at the stop was $1,000, 25% over budget. Step 0.25 returned 0.3, which is not a legal volume. Step 0.05 turned 0.15 into 0.2. |
| 2 | same, min-lot clamp | `agentMaxLot` 0.005 with min 0.01, or broker max 0.05 with min 0.1 | Returned the minimum lot **above** the agent cap or broker max. |
| 3 | same, input checks | `riskBudgetUsd = Infinity`, or `sizeMultiplier = Infinity` with no cap | Returned `lot = Infinity` with `cannotSize = false`. |
| 4 | same, multiplier | `sizeMultiplier = 3` | Sized 3× the budget. |
| 5 | same, `withinRiskBudget` | $150 budget × 0.5 multiplier, min-lot risk $100 | Reported `true` because it was judged against the unreduced $150, which undoes a PROTECT/RECOVERY cut. |
| 6 | `agentExecutor.ts` (lot gate only checked `cannotSize` / `lot <= 0`) | XAUUSD, contract 100, $1 budget, $10 stop: raw 0.001, clamped up to 0.01 | **Dispatched a lot that risks $10, 10× the budget.** Neither `reserveAgentEntry` nor the Phase B gate checks risk at the stop. |
| 7 | `quotaPressure.ts` | `dailyPnlUsd = NaN` | NORMAL regime with a 1.0 multiplier. An unknown P/L failed open. |

## Changes

- **Step arithmetic.** Lots are computed as integer step counts and converted back as `n × stepUnits / 10^d`, where `step = stepUnits / 10^d` exactly. This makes the result the nearest double to the decimal lot: no 0.1+0.2 drift, and 0.25 / 0.5 / 0.05 steps work. Rounding is always down. If representation slack overshoots, the sizer backs off one step.
- **Input checks.** A non-finite stop distance, contract value or budget refuses with its existing reason code.
- **Multiplier.** The multiplier is capped at 1. A value ≤ 0 or NaN keeps the defensive default of 1 that `selfTradeSafetyAuditTest` B12 pins.
- **Minimum above the cap.** A broker minimum above `min(maxLot, agentMaxLot)` refuses with the new `MIN_LOT_EXCEEDS_CAP`.
- **`withinRiskBudget`.** It is now judged against `effectiveRiskBudgetUsd = riskBudgetUsd × multiplier`, a new result field.
- **Dispatch verdict.** New pure `riskAwareLotBlockReason(result)` returns the sizer's reason, or `MIN_LOT_EXCEEDS_RISK_BUDGET`, or null. The executor uses it before reserving the entry, so an over-budget minimum lot is refused, not upsized.
- **Composed multiplier.** The executor refuses a non-positive or non-finite composed multiplier (`NON_POSITIVE_SIZE_MULTIPLIER`) before sizing, because the sizer would map 0 to full size. This is latent today: the only zero, AACI security lockdown, defers earlier.
- **Quota pressure.** A non-finite daily P/L now gives PROTECT (0.5, extra confirmation).

Existing behaviour is unchanged for in-budget, on-grid inputs. All prior suites pass unchanged.

## Invariants (`test:lot-sizer-invariants`)

These are seeded (mulberry32) and use no new dependencies. Risk comparisons allow a relative 1e-9 for input price-representation noise (1.1 − 1.095 is not exact). Grid checks are exact.

- I1: the lot is finite and > 0.
- I2: the lot is exactly on the step grid.
- I3: minLot ≤ lot ≤ min(maxLot, agentMaxLot).
- I4: rounding never exceeds the reduced budget. Only the minimum-lot clamp may exceed it, and then `withinRiskBudget = false`.
- I5: the lot is the largest legal lot within budget and cap.
- I6: a multiplier never grows the lot.
- M1: doubling the stop never grows the lot.
- M2: a bigger budget never shrinks the lot or makes it unsizeable.
- Q1: a non-finite P/L gives PROTECT.
- Q2: quota multipliers stay in (0, 1], a drawdown always gets < 1, near the cap gets 0.5, and composing with APPROVED_REDUCED only shrinks the lot.
- The sweep covers 20,000 inputs for I1–I5, 10,000 for I6/M1/M2 and 5,000 for Q2. Steps range over {0.001 … 5}, contracts 1–100,000, FX 0.003–3, prices 0.01–10,000, stops 0.001%–10% and budgets $0.01–$1M.
- On 5767ec5: 14 of 32 sizer checks failed, with 3,139 of 20,000 sweep inputs violating, and Q1 failed for NaN.

## Tests run (offline unless noted)

| Suite | Before | After |
| --- | --- | --- |
| scripts `test:self-trade-execution-domain` | 37/37 | 37/37 |
| scripts `test:self-trade-safety-audit` | 61/61 | 61/61 |
| scripts `test:objective-sizing` | 105/105 | 105/105 |
| scripts `test:money-truth` | 97/97 | 97/97 |
| scripts `test:realized-pnl-contract-size` | 40/40 | 40/40 |
| api-server `test:entry-sizer-quote-fx` | 12/12 | 12/12 |
| api-server `test:risk-pre-gates` | 17/17 | 17/17 |
| api-server `test:self-trade-lifecycle` | 44/44 | 44/44 |
| api-server `test:self-trade-entry-postgres` (temp cluster) | 73/73 | 73/73 |
| **new** scripts `test:lot-sizer-invariants` | 18/32 (sizer section) | 36/36 |
| **new** api-server `test:entry-sizer-risk-budget` | 3/7 fail with the executor change reverted | 7/7 |

Both new suites are appended to the root `ci` script.

## Latency (pure `computeRiskAwareLot`)

The benchmark makes 10,000 calls timed in batches of 10 after warm-up, on Node 24 in the shared dev container. Three runs:

| | Median | p95 | p99 |
| --- | --- | --- | --- |
| Before | 0.74–0.79 µs | 1.0–1.7 µs | 4.3–5.6 µs |
| After | 1.56–2.19 µs | 2.3–3.8 µs | 6.0–9.0 µs |

The roughly 1 µs increase comes from the step-decimals loop and the budget back-off check. The sizer runs once per decision, alongside database and broker round-trips measured in milliseconds.

## Remaining gaps (not changed here)

- **Broker volume specs.** The executor sizes with hard-coded `LOT_MIN = LOT_STEP = 0.01` and caps with `settings.maxLotPerTrade`. It does not use the broker's `arx_symbol_specs.minVolume / volumeStep / maxVolume`. Risk-governor rule 11 (`preTrade.ts`) refuses an off-step or below-minimum volume, so this fails safe, but symbols with step 0.1 or a minimum of 0.1 cannot be sized by self-trading.
- **Tick value.** Sizing uses `contractSize × quote→account FX`, not the broker's `tickValue / tickSize`. For CFDs whose tick value is not contractSize × tickSize, the value per lot may differ. Not verified against real specs.
- **Stop side.** The sizer uses `|entry − stop|` and does not check stop side. This is documented and caught by risk-governor rule 11 and Phase B.
- **Agent daily loss cap.** The agent-level `maxDailyLossUsd` is soft at this layer: PROTECT halves the size. The hard stop is the user-level Phase B daily-loss gate, as designed in `AUTO_TRADING_BOT_SAFETY_AUDIT.md`. A new entry's risk is not capped by remaining headroom (cap + daily P/L), and open positions' remaining risk to their stops is not counted. This needs an owner decision.
- **Budget currency.** The risk budget is `ledger.availableFunds × riskPerTradePct`, and the value per lot is in the account currency. If the ledger currency ever differs from the broker account currency, the two sides would mismatch. Not verified.
