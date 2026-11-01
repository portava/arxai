# Scanner screenshot evidence and corrections — 1 November 2026

Application commit: `fbbdb44c352cc1cdadd64f232fb1d9f3cbd51d14` on `codex/scanner-screenshot-truth-20261101`, based on `395d450e33e231e72f911b6fdbf2bff1badfcfb2`.

**Bounded offline acceptance passed. ARX remains NOT RELEASE GREEN. These changes have not been imported into Replit or deployed.**

## What the owner’s screenshots show

The M15 captures at 09:28–09:29 show inconsistent evidence presentation: an unverified UTC clock beside full/live-read claims, confidence substituted for momentum, a missing trendline explanation despite visible drawings, a questionable retest annotation, and overlapping headers/clipped status cards. Live market data and blocked trading can legitimately coexist; calling the former overall “Trade Health” makes that distinction unclear.

M30 follow-ups at 10:01–10:02 show the same earlier behaviour, a named bearish-marubozu/Break annotation absent from the explanation, and crowded last-price/annotation labels. These captures are not evidence that the new commit failed: the running preview was not changed. They do identify remaining chart-to-narrative and label-placement work.

Do not infer exact pattern validity, freshness or candle finality from these images. The earlier M15 displayed price 939791.40 is below the separately captured support lower bound 939893.3, but capture times differ. The later M30 price 937992.62 is inside its shown support band 937821.4–939265.4. Neither establishes a confirmed closed-candle support breakout.

## Implemented changes

- Shared Scanner truth now uses the same selected market/timeframe/source ownership and per-candle UTC evidence as the native chart. Unqualified clocks retain historical prices but cannot claim live freshness. Wrong-owner candles cannot supply shared prices or history identity.
- Explicit server setup-withheld, cannot-show-setup and insufficient flags cap the read status. A positive parent hint cannot override downgraded shared truth.
- Eleanor consumes qualified pattern/trendline notes and their conditional/context-only flags. Missing notes do not imply absent chart geometry. Confidence is no longer presented as momentum, and backend risk prose no longer converts structural confidence into “moderate edge” or a profit-probability claim.
- Hard restrictions suppress stale bias/HTF metrics and risk commentary. Historical structural context remains readable with its independent data limitation. Notices name restrictions without promising feed confirmation will resolve every policy or history limitation.
- Breakout/retest points use the first actually touching candle range, not the latest close. No retest point is emitted without a touch. Distinct event anchors no longer imply a diagonal price path.
- The native adapter is the single structural-overlay renderer. The Scanner’s duplicate renderer is removed; saved levels and trade/news overlays are retained.
- Global headers share one sticky wrapper. Status cards fit their container, and the readiness banner explicitly describes the current feed. Expanded history has its own clock limitation.

## Validation

| Check | Result |
| --- | --- |
| Combined dashboard | 3,560 pass, 0 fail, 11 skipped; 217 files pass, 1 skipped |
| Domain catalogue including retest regressions | 406 pass, 0 fail |
| Backend confidence-copy/name tests | 11 pass, 0 fail |
| Dashboard and API typechecks | Pass |
| Dashboard production build | Pass; sourcemap-location and large-chunk warnings retained |
| Guards | 85/87; existing wording guard has 38 matches and JSON-display guard 3 matches requiring context review |
| Offline actual-Scanner browser | 21/21 on clean, unchanged committed source; widths 1440, 790 and 390 |
| Prior build with the same final browser script | 11 pass, 10 fail |

Candidate fixture `85cb9da65dd848a5` binds to application commit `fbbdb44c352cc1cdadd64f232fb1d9f3cbd51d14`. Baseline fixture `e7b2b265cb5d18bb` binds to `76cd4bd634e6b5af5188c5bb0d823b95e7aeb44e`; that application tree is unchanged in the documentation-only base `395d450e`. Dashboard tests ran on the identical application source immediately before commit. Build/browser receipts bind the clean committed tree. Domain and backend test additions are wired through existing CI scripts.

Independent review found additional owner binding, clock scope, parent-override and restricted-metric/risk bypasses; each was corrected before final acceptance. Before-fix failures and intermediate failures are retained. An initial browser fixture used a last-closed open outside the freshness budget and stalled; it was stopped and corrected, with no production relaxation. Expected unavailable auxiliary endpoints return intercepted 503 responses; no page exceptions occurred in the final browser run.

## Limits and next work

1. No screenshot-source OHLC/read snapshot or real provider replay was available. Generated browser candles and an intercepted analysis response prove the presentation paths only.
2. Broader breakout detection still selects from all detected swings and finds a first beyond-level close; causal pattern-detection completeness is not established.
3. Native annotations and narrative child evidence can originate in distinct analyses. This change exposes supplied notes honestly; it does not establish universal agreement across every detector. Explain the selected marubozu/break finding using its actual evidence next.
4. Review overlapping right-axis price/annotation labels from the M30 follow-up. Their spacing is not fixed by this commit.
5. Declared UTC evidence and selection consistency are not independent provider authentication. Current-feed qualification does not qualify older loaded history.
6. No timing, competitor parity, physical-device, model-quality, broker, terminal or full root-CI claim. The two guard failures remain open. The earlier sanitized ChatGPT crosscheck is separate evidence and did not verify these new screenshots.
7. No main merge, Replit source update/restart, deployment, existing database mutation, worker/trading/settlement/email activation, or live/demo broker test occurred.

Raw local receipts: `/Users/areyouok/arx-tier1-release/scanner-screenshot-truth-20261101/`.
Portable receipts, checksums and raw archive: `docs/validation/scanner-screenshot-truth-20261101/`.
