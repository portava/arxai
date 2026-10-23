---
name: ARX Top 250 universe lock (FE registry + scanner)
description: How the approved-market lock is sourced/derived and the routing-key trap to avoid.
---

# ARX Top 250 universe lock

The approved universe is `@workspace/markets` (`ARX_TOP_250`, `resolveUserMarketInput`,
`ArxMarket`). It is the SINGLE source of which markets a regular user may
see/search/scan/chart/trade. Every surface intersects provider/broker discovery
against it (`providerSymbols ∩ approvedTop250`), never exposes raw provider output.

**Rule:** visibility/filtering/resolution only — NEVER change live execution routing,
MT5 bridge, or weaken a safety surface.

## FE registry derivation (symbolRegistry.ts)
`SYMBOL_REGISTRY = [...CURATED, ...DERIVED]`, exactly 250 entries.
- CURATED entries win and **preserve the exact canonical routing keys** the chart bus /
  broker resolution depend on: `V75`, `NAS100`, `SPX500`, `BTCUSDT`, … Do NOT swap these
  to the Top-250 `standardSymbol` (US100/US500/BTCUSD/"Volatility 75 Index") — it breaks
  the chart-symbol bus + broker resolution. Providers' standard forms go in `aliases`.
- DERIVED covers every non-hidden approved market not already curated, keyed by a
  router-safe canonical: crypto → `*USDT` providerSymbol; everything else → `standardSymbol`.
  Curated coverage is detected via `resolveUserMarketInput(canonical).market.id`.

## MarketType extension
`MarketType` gained `energy` + `commodities`. Any new MarketType value must be added in
THREE places or it silently disappears: the union, `groupByMarketType`'s record init, and
`SymbolExplorer.tsx` `CATEGORY_ORDER`.

**Why:** energy (oil/gas) and commodity markets have no forex/metals/indices home; without
the new buckets + CATEGORY_ORDER rows they'd be in the registry but never rendered.

## Verify
- `pnpm --filter @workspace/scripts run test:arx-top250` (universe + resolver, 40 cases).
- Registry self-check: size===250, 0 non-approved (every `canonicalSymbol` must
  `resolveUserMarketInput`→resolved), 0 duplicate canonicals, curated keys still resolve to
  themselves.
