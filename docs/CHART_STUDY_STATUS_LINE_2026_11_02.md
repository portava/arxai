# Independent study status readout — 2 November 2026

Status: implemented, independently reviewed and accepted offline. The full competitive chart and launch-readiness goals remain incomplete. No performance-superiority or overall parity claim.

## Comparison and scope

Official documentation checked 2 November 2026:

- [TradingView indicator values](https://www.tradingview.com/support/solutions/43000659666-i-want-to-hide-the-values-of-individual-indicators/) documents independent per-indicator status values and scale labels, subject to global visibility settings.
- [MetaTrader 5 indicators](https://www.metatrader5.com/en/terminal/help/charts_analysis/indicators) documents a separate Data Window control and scale-by-line behavior.

ARX already had Data Window visibility. This change adds an independent opt-in **Show values in status line** setting for each existing native study. It supplies a compact observation readout without requiring the Data Window to remain open. Scale-label and global status-line controls remain separate open gaps; this is not a replacement of the whole competitor feature set.

## Behavior

- Old workspaces remain uncluttered: omitted status preference means off. Explicit booleans persist through reload and duplication; invalid truthy values are rejected.
- Values come from the existing exact-time native study observations. Missing timestamps, warm-up values and unqualified inputs are not substituted with another observation or zero.
- The readout identifies **Pinned candle**, **Inspected candle**, **Linked candle**, or **Latest loaded candle**. A renderer without origin metadata uses the neutral **Candle observation**. An origin/timestamp mismatch withholds the new readout.
- The native adapter's existing latest-candle fallback is unchanged. Its crosshair output and origin metadata now share the same resolver, avoiding disagreement about which candle is being described.
- Plot visibility, pane geometry, linked-study calculations and Data Window settings remain independent. Readout-only changes preserve the exact pinned candle. Simplified view and unverified presentation withhold status numbers.
- Source/interval changes retire the old selection; the new source's latest fallback is explicitly labeled rather than represented as a user selection.
- Pointer-driven output has `aria-live="off"`; existing dedicated pinned-candle announcements remain. No study-value query is introduced while both status and Data Window readouts are unused.

## Exact source and validation

Parent checkpoint: `77eea9c8ca19f7fcdc411c3495f214168b75c8e6`.

Initial implementation: `ab49d817`; origin correction: `6259d36f4425e2aec452b36951f6055939108d00`; final application and driver: **`3a0443d7772fe568c27dfd0296ade5d3100d4f34`**. Branch: `codex/chart-study-status-line-20261102`.

Final checks on `3a0443d7`:

- Frontend: **4,970 passed, 12 skipped, 0 failed**; 289 files passed, 2 skipped; 123.83 seconds, two workers, original deadlines.
- Type checking and production build pass. Existing large-chunk warning remains.
- Guards: **85/87**. The same `risky-wording-frontend` and `no-internal-names-user-ui` failures remain; all 43 normalized failure lines match the prior checkpoint. Not all-green CI.
- Independent source review clear; all 14 final reviewed file hashes match.
- Offline browser: **14/14**, clean native-default production fixture `938c4778d4070849`, actual Market Scanner route, synthetic historical candles and intercepted APIs.
- Browser checks cover opt-in defaults, exact historical RSI value, pin preservation, unchanged candles/geometry, independent Data Window behavior, numeric withdrawal, reload, corrected interval-origin labeling, narrow-screen wrapping and absence of a TradingView embed/logo.
- 96 requests, 7 expected blocked POSTs, 0 unexpected blocked requests, 0 page errors. 58 unavailable endpoint records and 65 offline console errors are retained; these are not passing backend integrations.
- Desktop and 390px screenshots inspected. Owned browser sessions closed and fixture servers stopped.

## Retained failures and review corrections

- Feature baseline: 4 failed, 14 passed; then 18/18 focused checks passed.
- Reviewer-found pin loss: 1 failed, 72 passed before excluding the new preference from plot identity. Repaired; four focused files passed 193 checks.
- Reviewer-found repeated screen-reader announcement risk corrected with explicit non-live output and a shell assertion.
- First browser stopped after 7 checks because it sampled the Data Window's initial placeholder before the toggle callback completed. Its screenshot is retained. The driver now awaits the actual visible result with the original timeout; this is not evidence of immediate completion or latency compliance.
- The next run stopped after 11 checks at interval replacement. A diagnostic rerun established that the native pin was cleared and M30 data was ready, but the new text called the latest-loaded M30 candle selected. This was a real labeling defect, repaired in application code, not hidden by relaxing the original selection assumption.
- Final browser checks the supported behavior precisely: cleared pin, M30 source, and the new latest-loaded value from the exact native observation, explicitly labeled as such. The accessible output name was also generalized to avoid a false selected-candle promise.
- Earlier full suites on intermediate commits are preserved separately: 4,969 passed on the initial application and 4,970 passed after origin repair. Those runs are not attributed to the final source.

Evidence packet: `/Users/areyouok/arx-tier1-release/chart-study-status-line-20261102/`.

## Remaining goal and boundaries

Open comparison work includes indicator scale labels and global status controls, pane shortcuts and arbitrary pane merging/main relocation, whole-chart layout splitters, MT5 scale-by-line, detachable Data Window, multi-symbol/timeframe studies, scripting, deeper qualified history, remaining drawing/chart families, cloud workspace/server alerts, and fair repeatable competitor performance measurements. Earlier navigation and 4x-CPU failures remain open. Physical touch, assistive technology, deployed-app acceptance and full backend/root CI are not claimed.

The owner's separate performance chat retains the broad optimization work. Its changes and held experiments were not imported. No main/PR76 merge, Replit sync, deployment, existing database migration, worker/trading enablement, email, funds movement or live/demo broker test occurred.
