---
name: One feed verdict across scanner/Ruby/floor
description: there is ONE per-symbol freshness verdict feeding scanner, Ruby, and the synthetic-live floor; the non-obvious constraints when wiring a new surface to it.
---

There is exactly ONE per-symbol feed verdict (recent-tick + candle freshness → live / live-but-delayed / awaiting), and it reuses the existing candle-freshness classifier's thresholds.

**Rule:** never introduce a second staleness threshold for a new surface. A recent tick with a delayed newest bar is its own honest state ("live-delayed"), distinct from both clean-live and awaiting/stale.

**Why:** a Deriv-synthetic feed can have a fresh tick while its newest candle is delayed; if any surface treats that as fully live it misleads the user and (worse) can let a synthetic position through the live floor on stale bars.

**Non-obvious constraints when wiring a surface:**
- The `ChartFeedStatus` API type exposes both a `quality` label AND the raw `trailingIntervals` gap (clean <=1, delayed 2, stale >=3, null when unknown). Still derive the live-delayed state by combining `quality === delayed` with a recent-tick check, not the gap alone — otherwise a no-tick "delayed" (awaiting-tick) is mislabeled as "live tick active but delayed."
- After editing the OpenAPI spec + running codegen you MUST rebuild the composite libs (`pnpm run typecheck:libs`) before any consumer typecheck. The lib's emitted `dist/*.d.ts` is gitignored, so a stale build makes apps fail on freshly-added fields even though the committed generated source is correct.
- The synthetic-live floor must require the *clean-live* verdict to pass; both live-delayed AND awaiting block it, at BOTH preflight and dispatch (two separate call sites — easy to tighten one and miss the other).

**Verification gotcha:** an authenticated side-by-side scanner/Ruby screenshot is NOT capturable in this env — the app is behind a login wall (401) and the screenshot tool sends no cookies and cannot interact. Prove these surfaces with the scanner-truth-caps copy test + the synthetic-live-floor unit test instead.
