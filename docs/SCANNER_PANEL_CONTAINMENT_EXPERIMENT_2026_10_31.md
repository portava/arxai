# Scanner supporting-panel containment experiment — 31 October 2026

Verdict: **HELD; not selected for development import. ARX is not release-green.**

Candidate `363c9e43199c99db31fd1f6e921af586f4f21146` adds a single wrapper around the below-chart Trade Health and page-tab sections. CSS `content-visibility: auto` may skip offscreen layout/paint; it does not defer React rendering, data subscriptions or mounting. Chart and trade dialogs remain outside. Base `577dba1b7d1e0845da01243e35b2579753363a9a` retains application `b107f1db1da17502ab978fccefee9f162efff8f4`. Do not use this experiment as the next application base.

## Exact-source checks

Candidate: 174 frontend files pass, 1 skipped; 2,555 tests pass, 11 skipped; dashboard typecheck/build pass, 87/87 guards, 7/7 binding assertions. Regular minified fixture `18274081f43b682b` was built from the clean candidate. No root CI, backend/database or broker tests ran.

Unchanged baseline fixture `c158d9634a95fd80` was built at tooling source `c28122b9320873fbcb432c0409ab1c159c7b6f9f`; application remains b107f1db. Profiling is off in both fixtures. All 40 planned attempts are retained, including all 20 slowed-CPU failures. Fresh isolated browser contexts, all app API requests intercepted, synthetic historical 200 bars, fixed 80 ms candle delay, no active AI analysis. Warm prepared browser resources; each attempt reloads the document. Mobile means viewport resizing, not a physical device. No competing build/test command ran during these batches; host contention is not proven absent.

## Same-window results

Each cell is median / maximum milliseconds across five valid attempts. Completion requires exact canonical/displayed OHLC and actual series identity, visible unobscured plot, and two rendering frames. No gates were relaxed; 100 ms remains the target.

| Build | CPU rate | Desktop | Mobile width | At or below 100 ms |
|---|---:|---:|---:|---:|
| Candidate | 4 | 298.2 / 373.8 | 279.0 / 284.7 | 0/10 |
| Baseline | 4 | 304.1 / 346.7 | 271.5 / 289.0 | 0/10 |
| Candidate | 1 | 40.2 / 40.3 | 37.8 / 99.6 | 10/10 |
| Baseline | 1 | 38.5 / 98.4 | 99.4 / 100.0 | 10/10 |

Order: candidate 4×, candidate 1×, functional checks, fresh baseline browser 4× then 1×. Five observations per viewport and sequential batches do not establish statistical superiority. Slow-CPU desktop median improved only 5.9 ms while its maximum worsened 27.1 ms; mobile median worsened 7.5 ms. Normal-CPU results vary with scheduling and both already pass. No reliable overall improvement is established.

A separate functional run recorded `contentvisibilityautostatechange` with `skipped: false` on both sizes; no skipped state was observed. This does not prove every timing attempt behaved identically, but it undermines the proposed mechanism for the tested nearby panels. React work remains unchanged.

Keyboard Tab from the last chart control reached Focus visibly; ArrowRight/End/Home switched Broad Scan/Symbols/Focus. Scrolling back preserved chart/series identity and exact chart data; no horizontal overflow or page exception. Screenshots retain the existing mobile assistant-orb overlap with lower chart controls; this candidate does not fix it. No full assistive-technology, find-in-page, popup-clipping or arbitrary-scroll-jump acceptance claim is made.

## Replit recorder outcome (separate environment and source)

Read-only remote report: final workspace checkpoint `5e98c0aa3361a9ccd6588660f2e0b64533b6fab9`, tested combined source `c4856d8d001c4a851b8dfa8aaffec3ef3b71b07a`, application unchanged `f3467de7c5f60038a139a60f00abe56d563f0cc4`, fixture `167dde6dc4eb7a18`. Tooling: 22 tests pass, no failures/skips, three syntax checks, fixture build and preservation audit pass; broad application suites not rerun. Twenty attempts/results survived shutdown. Performance: **0/20 under 100 ms**. These are not results for this CSS candidate.

Immediate desktop samples: 308.3, 257.4, 331.6, 212.6, 217.9 ms (indices 0 and 3 also violate readiness-to-click). Immediate mobile-sized: 204.0, 181.4, 248.4, 161.1, 176.8. After explicit 1500 ms idle: desktop 210.6, 138.0, 255.3, 110.9, 207.9; mobile-sized 142.0, 113.5, 116.6, 109.7, 105.2. Earlier remote failures and unrecoverable old timeout remain retained.

Remote run was workspace-local Linux HeadlessChrome 152 / Playwright 1.64.1, configured CPU rate 1, DPR 1; not the earlier remote browser worker. Actual browser candle responseEnd was 1372.8–1459.8 ms before the idle clicks. Browser receipt is not JSON parsing/cache adoption/module evaluation. Thus prefetch alone is insufficient; do not attribute the remaining delay to a particular mechanism without profiling. No direct published-app/provider/competitor timing is proven.

## Next

Continue from the accepted application base, not this held experiment. Use the retained React profile to reduce actual repeated rendering/effect work, then rerun unchanged acceptance in both environments. Preserve all TradingView/MT5 capability and performance gaps. No main merge, Replit application import, deployment, existing database change, trading/worker enablement or broker execution occurred here. Owned fixture browsers/servers were closed.

Raw evidence: `/Users/areyouok/arx-tier1-release/scanner-panel-containment-20261031`. Portable receipts and checksums: `docs/validation/scanner-panel-containment-20261031/manifest.json`.
