---
name: Ruby chat footer must mirror the Scanner header feed verdict
description: The chat/panel data-quality footer (chartRead.trustLine) must derive feed confidence from the SAME source the Scanner header uses, fail-closed, and downgrade a verified read when the live feed is unconfirmed.
---

Ruby's chat/panel data-quality footer (`chartRead.trustLine`) must derive its feed
confidence from the SAME `getChartFeedStatus(symbol, tf)` the Scanner header badge
uses — NOT from the raw gate flags / `buildTrustLine` success line.

Rule:
- Resolve "feed unconfirmed" fail-closed: client-observed `aiUsable === false` OR
  server `feedStatus.aiUsable !== true`; a null / thrown / unknown feed status is
  treated as unconfirmed (`resolveFeedUnconfirmed`).
- A VERIFIED-basis read (enough CLOSED history) MUST still DOWNGRADE FULL →
  STRUCTURAL_ONLY when the header feed is unconfirmed.
- Withheld reads use dedicated builders: `buildStructuralReadTrustLine` for
  STRUCTURAL_ONLY, `buildGatedTrustLine` for INSUFFICIENT. The verified success line
  (`rubyCtx.trustLine`, which may say "Verified · Live feed · AACI verified") is
  reused ONLY in the VERIFIED FULL branch.
- Forbidden confidence tokens on any withheld read: `Verified`, `Live feed`,
  `AACI verified`, `Live-confirmed`, `Execution-ready`.

**Why:** the bug was a V75 1H read where `rubyCtx.basis` was VERIFIED (enough closed
bars) but the live feed was unconfirmed, so the chat footer claimed
"Verified H1 candles · Live feed · AACI verified · Forming candle active" while the
Scanner header correctly showed "Historical only / Feed not confirmed / Limited
read". The two surfaces disagreed because the footer read raw gate flags instead of
the header's feed verdict.

**How to apply:** any new chart-read / footer surface routes feed-confidence through
the shared `getChartFeedStatus` + `resolveFeedUnconfirmed`. Enforcement lives in
`rubyStructuralReadService.ts` (`buildRubyStructuralRead`); the
`POST /me/assistant/read-chart` route only DELEGATES to it (no inline gated branch).
Because the gated/structural honesty moved out of the route into the service, static
honesty guards (e.g. gatedChartTrustLineHonestyTest #09) must target the SERVICE,
not scan the route for an inline branch — a route-scoped guard silently goes stale
after such an extraction. readLayer stays display-only — none of this touches
execution / the 23-gate dispatch / SL.
