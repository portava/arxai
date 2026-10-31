# Scanner first view: mobile layout and strict navigation evidence

Checked application/tooling: `9ebb687ae9e0b68c4ad250d5ad72843ad5bb8940`. Immutable production fixture: `552924174f969fd3`. This report/receipt commit does not change checked code. Draft PR103; not installed in Replit or published. Launch readiness and the under-100ms completed-chart target remain unproven.

## Change

On a 390×844 phone viewport, the previous Scanner plot began around y=1215, below the screen. Mobile now puts the plot before secondary chart controls in DOM/keyboard order, provides fullscreen above the plot, and collapses duplicate feed metadata and longer status explanations. Main Data/Eleanor/Trading/Action verdicts, readiness, source identity, mirror state and data-quality warnings remain visible. Details remain accessible; desktop expands them. The chart engine/canvas is retained through breakpoint changes. Outer last-close formatting uses the existing price formatter.

The first layout attempt still left the plot around y=797–825 and failed all five mobile visibility samples. The second correction exposes at least an unobscured 100×100 plot region in all five samples. This is bounded first-view acceptance, not proof that the whole chart fits on every phone. The final screenshot includes a delayed-stream warning and still has limited plot space; fullscreen exposes the larger plot. Smaller screens, physical touch and real-feed acceptance remain open.

## Strict first-click method

New checked-in tools: `scripts/scanner-qa/shared-chart-first-navigation.js` and its regression tests. Each sample fully navigates home, observes the primary navigation link becoming actionable in-page, and clicks it without an intentional hover/wait or pre-click metadata inspection. Desktop uses the sidebar; mobile uses the fixed bottom navigation. The recorded click must be trusted and within150ms of readiness. Five samples per viewport are retained, including failures.

Timed frames require exact complete canonical AND displayed OHLC, source/symbol/interval/style, actual engine/series identity, logical range, and an unobscured ≥100×100 plot region. Source readiness and viewport visibility are recorded separately. Two consecutive matching animation frames are rendering opportunities, not measured physical paint. Build/network evidence is checked after each sample.

The first harness selected a lower home CTA on mobile and scrolled before clicking. Those five mobile measurements are invalid methodology, not application latency. The selector was corrected before the baseline used below. A later visibility helper searches candidate clear regions rather than rejecting a plot merely because bottom navigation covers its lower edge. Full current results use that helper. Every intermediate is retained.

## Results

| Checked source / build | Desktop | Mobile | Conclusion |
| --- | --- | --- | --- |
| `53ef1c9f` / `632a4b0199981f55` | 5 valid; median115.9ms | wrong lower CTA; invalid | Retained method failure |
| `3c715592` / `6ec3cbc736de1fbd` | 5 valid; median116ms | 0/5 visible completions; source≈115ms | Plot below viewport |
| `b9d744f2` / `5d0a95a366e1c87a` | 5 valid; median115.6ms | 0/5 visible completions | First layout insufficient |
| **`9ebb687a` / `552924174f969fd3`** | **5 valid; median115.4ms; max115.6ms** | **5 valid; median115.7ms; max116.3ms** | **0/10 meet100ms; overall timing verdict remains FAIL** |

All runs use200 synthetic bars, a fixed80ms candle response, an unavailable active reader and blocked external/API mutations. They measure first navigation after document reload in an already-running browser with its cache, not a cold browser process, real provider response, actual Replit delay, analysis completion or competitor performance. The older navigation report used a weaker method; its measurements are not directly interchangeable with these.

## Verification

Exact final source: frontend **2,434 pass /11 skip /0 fail**,170 passing files and one skipped opt-in benchmark file; dashboard typecheck/build pass; **87 guards**, **7 binding assertions**, **84 tooling tests** pass. Two mobile-order regressions failed on the original implementation, then passed. Focused final layout run59/59 passes. Full root CI/database integration was not run for these UI/tooling changes.

Production browser controls:10 checks pass for status/feed disclosure, fullscreen identity/exact bars, actual zoom/pan logical-range changes and preserved canonical candles. Desktop details remain expanded after resizing. Screenshots inspected. Initial desktop probe used a visible-only locator for the intentionally hidden mobile button; that helper timed out, was corrected and is retained. The malformed intermediate fullscreen aria-label caused2 focused failures, corrected before final commit. All previous failures, build/runtime environment issues, outliers and original receipts remain available.

## Evidence and next work

`docs/validation/scanner-first-navigation-strict-20261031/manifest.json` hashes archived raw logs, samples and screenshots. Names `final-result.json.gz` and `final-run.log.gz` are the **failed intermediate**; `accepted-result.json.gz` is the current run, whose `passed` is still false because all timing samples exceed100ms. Do not relabel it as a latency pass.

Replit's separate development checkpoint remains `619f259db5f265a379190de42ff39fa5f876c768`: code checks passed but immediate-first-click acceptance failed. New reader-cache/mobile/tooling changes are GitHub-only. Need selective development integration preserving newer safety/auth/Truth/backend work, actual preview timing and source-correct real-feed/active-analysis acceptance. Held performance branches remain excluded. No main merge/deploy/database mutation/worker activation/broker test occurred. Owned offline browser/server stopped.
