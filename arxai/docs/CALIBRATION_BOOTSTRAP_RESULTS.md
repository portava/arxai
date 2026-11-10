# Calibration bootstrap: measured results on real history

Measured 2026-11-10 by replaying every replayable strategy and agent on the two
pinned real-history fixtures. Reproduce with:

```
pnpm --filter @workspace/api-server run calibration:bootstrap -- --report
```

| Fixture | Dataset hash | Series |
|---|---|---|
| `real-history-v1` (FRED FX + Binance, daily, 2010-2025) | `fa83f149…dbc6d232` | 10 |
| `real-history-intraday-v1` (Deriv V-indices, FX, gold; M1/M5/M15/H1) | `a5f9b3cc…a9725dc` | 32 |

Both are pinned in `artifacts/api-server/src/lib/calibration/historicalFixtures.ts`; a tampered or re-hashed copy is refused.

## Strategies (pooled `strategy|*|*`, source `historical_replay`)

| Strategy | N | Base rate | Served model | Edge detected |
|---|---|---|---|---|
| Trend Continuation | 7243 | 0.3849 | base rate | no |
| Break of Structure | 2136 | 0.3764 | base rate | no |
| Liquidity Sweep Reversal | 3164 | 0.3448 | base rate | no |
| Volatility Expansion | 943 | 0.4083 | base rate | no |
| Pullback Continuation | 5982 | 0.3034 | base rate | no |
| Session Breakout | 452 | 0.4093 | base rate | no |
| Mean Reversion | 0 | – | unmeasured | – (see the defect below) |

Session Breakout is now measured: it replays on each bar's own session time,
and the intraday fixture contains London and New York bars.

No strategy's score beats its base rate out of sample, so every probability
served is the measured base rate with its N. This agrees with the validation
factory (0 survivors on daily and intraday real history).

## Agents

| Agent | N | Influence | Basis |
|---|---|---|---|
| STRUCT | 11336 | 0 | no out-of-sample skill (lower95 = −0.000089) |
| RISK | 11336 | 0 | no out-of-sample skill (constant read) |
| PRECISION | 11336 | 0 | no out-of-sample skill (lower95 = −0.000022) |
| SCANNER_AI | 11336 | 0 | no out-of-sample skill (lower95 = −0.000132) |
| ELEANOR, EXEC, SCALP_AI, EXIT_TP_AI, TRADE_REVIEW_AI, 5 ops agents | 0 | 0 | no replayable record, each with its stated reason |

The admin Agent Ecosystem page now shows this measured influence, N and reason.
The registry's own trust and authority scores are labelled as not validated
and not driving influence.

## Known defect: Mean Reversion cannot fire

`meanReversionStrategy` requires RSI(14) < 28 (or > 72) **and** a 20-bar close
range below 1.2 × ATR(14). An RSI that extreme needs a sustained one-way move,
and that move makes the 20-bar close range much wider than 1.2 × ATR. The two
conditions exclude each other in practice: the rule fired **0 times** on all 42
real series (129,504 bars). The strategy therefore always reports
"no setup".

Redesigning the rule changes which BUY/SELL signals users see, so it is an
owner decision. Until then `historicalBootstrap.test.ts` pins the 0-fire result
as a known defect; a redesign must replace that pin with a measured result.
