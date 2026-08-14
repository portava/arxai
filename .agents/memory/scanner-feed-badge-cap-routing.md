---
name: Scanner feed badge cap routing
description: How FeedConfidenceBadge honesty is enforced on the Scanner chart panel and per-signal scalp cards
---

# Scanner feed-badge cap routing

On the Scanner chart panel (`ScannerChartPanel.tsx`) and the per-signal scalp
cards (`ScalpSignalCard.tsx`), the `FeedConfidenceBadge` (the only badge that can
read "Clean · AI") is reachable **only through `RubyChartRead`** — both files
render `<RubyChartRead>` and do NOT render a raw `<FeedConfidenceBadge>`.

`RubyChartRead` caps that badge with `aiUsableResolved={panel.badgeAiUsable}`,
derived from the shared `useScannerTruth` verdict via `resolveRubyReadPanelState`
(full ⇒ true, downgraded ⇒ false, unresolved ⇒ null).

The Scanner chart **header** badge is the separate honest `ChartFeedStatusBadge`
(copy-fixed) which never claims Clean/AI.

**Why:** prevents the "Clean · AI" badge contradicting a downgraded resolved
scanner truth. The honesty holds structurally, not by props on the two files.

**How to apply:** never drop a raw `<FeedConfidenceBadge>` into these two
surfaces — route it through `RubyChartRead`, or pass `aiUsableResolved` derived
from `useScannerTruth`. The guard `ScannerFeedBadgeCap.test.tsx` fails the build
if a raw badge is reintroduced. The cap helper is `capConfidence` in
`lib/feed-confidence.ts`; the badge exposes `data-ai-usable` for DOM assertions.

Other surfaces still render an UNCAPPED `FeedConfidenceBadge`/`ChartFeedConfidence`
(live-chart `ARXNativeChart`/`ChartTradeEntry`, trade-command-room
`QuickTradePanel`) — out of scope here; they lack a scanner-truth verdict to cap by.
