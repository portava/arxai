---
name: Eleanor market-tool feed-status contract
description: Market-tool block/withheld/error branches must emit the honest feed-status shape, never undefined
---

Rule: In `artifacts/api-server/src/lib/assistant/tools.ts`, every block / withheld /
error early-return of a market tool that exposes a feed signal in its SUCCESS shape
must carry the SAME honest feed-status contract (feedConfirmed:false + feedCaveat +
source/quality/freshness). Never leave those fields undefined.

**Why:** An undefined feedConfirmed/freshness handed to Eleanor made her market
answers go silently blank — she reads `context.feedConfirmed` (context tools) or
top-level `feedConfirmed` (snapshot) to decide whether to lead with the caveat.
Undefined ≠ false, and undefined is what broke her.

**How to apply:**
- Two shared helpers exist: `unavailableFeedStatusFields()` = FLAT (top-level feed
  signal: getMarketSnapshot, the shared `withheldAdvicePayload`);
  `unavailableFeedContext(cause)` = NESTED under `context`
  (getSymbolMarketContext / getTradeMarketContext). Pick by the tool's success shape.
- getTradeMarketContext's withheld branch returns BOTH the flat withheldAdvicePayload
  fields AND a nested `context` — coherent, both assert the same verdict.
- EXEMPT: `getTradeDecisionTool` — its success shape has no `context.feedConfirmed`;
  Eleanor reads `decision.dataQuality.marketContextQuality` there (systemPrompt). Do
  NOT add a context field to its branches.
- OUT OF SCOPE: `rubyStructuralReadService.ts`, `rubyReadLayers.ts`,
  `readChartStructureTool` — they carry feedConfirmed inside a `readLayer` contract
  that is already honest on every branch (different contract, don't touch).
- Purely response-shape. Never weakens an honesty gate: blocks still block, nothing
  is fetched, no price fabricated. Values mirror what getMarketSnapshot's ARX block
  already emitted.
