---
name: MT5 provider stale semantics
description: getMt5AllSeriesStatus "stale" means two different things; in-memory store resets on restart
---
`mt5Provider.getMt5AllSeriesStatus()` returns status `"contributing"` only when a
series is fresh AND non-empty. Everything else (aged-out past CANDLE_TTL, OR a
fresh push with barCount 0) collapses to `"stale"`.

**Why:** A "feed stopped pushing" detector must distinguish a genuinely
stopped/aged-out series from an empty-but-fresh push (which is NOT a stopped
feed). Gate stopped-feed alerts on `ageMs != null && ageMs > CANDLE_TTL_MS`
(import the exported `CANDLE_TTL_MS` — one source of truth), never on
`status === "stale"` alone.

**How to apply:** The candle-feed staleness watchdog
(`lib/data/mt5FeedStalenessWatchdog.ts`) only alerts for previously-CONTRIBUTING
series that aged out. The provider's candle/quote store is pure in-memory and
empty on server restart, so "previously contributing" knowledge resets on
restart — alerts only fire after a series contributes again post-restart (this
is honest, since we can't know pre-restart state).
