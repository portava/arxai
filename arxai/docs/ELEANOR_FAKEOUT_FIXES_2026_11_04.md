# Eleanor fakeout SL/TP authority — review fixes (2026-11-04)

Stacked on PR #115 (`claude/trading-sweep-20261104`), which carries PR #111's fakeout authority.

| # | Problem | Fix |
|---|---|---|
| F1 | The rule asked "is there a long wick against the position?" using trade-intelligence's `fakeoutRiskScore`, which measures the PROFIT-side wick (upper wick for a long). A real stop-hunt (long lower wick on a long) scored low and never shifted; a profit-side rejection could. | `adverseWickPct(side, bar)` reads the stop-side wick from the bar itself; the score is kept only as information. |
| F2 | After the 15-min cooldown the same completed bar could trigger again (data delay, slow feed). | One shift per bar: the bar's open time is stored (`lastFakeoutBarAt`) and reused bars are skipped. |
| F3 | A completed bar from a stalled series could drive a shift. | The bar must have closed within 2 intervals of now. |
| F4 | Refused shifts (gate, broker stops level) had no cap: a CRITICAL alert every 15 min. | Eleanor stops after 2 refused attempts per monitor and leaves the levels to the trader. |
| F5 | The watches strip only showed a shift count. | It shows the last shift, or why it was refused. |

Tests: `eleanorFakeoutPolicy.test.ts` (in `test:mt5-order-controls-20261104`, 56) and `EleanorWatchesStrip.test.tsx` (7).
