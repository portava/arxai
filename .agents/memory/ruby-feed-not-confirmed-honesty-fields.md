---
name: Ruby feed-not-confirmed honesty fields & stale truth-gate fixtures
description: Why the ruby-feed-not-confirmed suite regressed and the honest way to fix it (blocked/early-return payloads must carry feed fields; test positions must be genuinely verified-live).
---

When a Ruby/Eleanor market tool short-circuits (ARX Focus block, withheld
advice, resolver error), the early-return payload must STILL carry the honest
feed-confirmation fields the happy path exposes — `feedConfirmed:false`,
`feedCaveat`, `source:null`, `aiUsable:false`, `freshness:"UNAVAILABLE"` — never
leave them `undefined`.

**Why:** the user-facing failure is the assistant returning a blank/undefined
feed status instead of an honest "feed not confirmed — low confidence" caveat.
getMarketSnapshot exposes these TOP-LEVEL (no `context` wrapper);
getSymbolMarketContextTool / getTradeMarketContextTool nest them under `context`.
Adding honest fields to a block is NOT weakening the gate — no data is fetched,
no price fabricated, `blocked:true`/`isApprovedMarket:false` stay.

**Stale-fixture trap:** honesty gates get added AFTER tests are written, silently
breaking them.
- The ARX Focus lock (getMarketSnapshot) now blocks off-universe tickers like the
  test's `ZZNOFEEDXX` before the shared resolver runs.
- The Live-Position Truth gate (`classifyTradeKey`→`resolvePositionTruth`) withholds
  any synthetic open position that isn't verified-live. A test row is
  verified-live only with: broker ticket present, all core fields, AND
  `lastSyncedAt` FRESH (within 90s → freshness=="FRESH"; a null lastSyncedAt ⇒
  MISSING ⇒ withheld). A withheld position returns `ok:false` with NO `context`,
  so a "confirmed feed" assertion can never pass — the fix is a correct fixture
  (fresh lastSyncedAt), not touching the gate.

**How to apply:** to make such a suite pass without weakening honesty, prefer
(a) enriching block/early-return payloads with honest feed fields, and (b) giving
test fixtures the real shape a verified row would have — never relax the gate.
