---
name: Assistant symbol-validation cap vs Deriv synthetic names
description: Why Ruby read-chart / explain-signal 400'd on Volatility indices and how wide the symbol cap must be
---

Ruby's read-only assistant endpoints (`/api/me/assistant/read-chart`,
`/api/me/assistant/explain-signal`) validate the request body with a zod schema.
A too-tight `symbol` cap silently rejects legitimate Deriv synthetic index names.

**Rule:** any assistant/trade symbol validator must accommodate Deriv synthetic
index names, which are long and contain spaces/parens — e.g.
`"Volatility 25 (1s) Index"` = 24 chars, `"Volatility 100 (1s) Index"` = 25.
Use `max(64)` (matches the OpenAPI symbol `maxLength: 64`), never `max(20)`.

**Why:** `max(20)` made `safeParse` fail → handler returned `400 invalid_body`,
which the UI surfaced as "Ruby couldn't read this chart (HTTP 400)" — even though
the `/api/data/candles` route (no length cap) renders those same symbols fine.
The failure is symbol-name-length-dependent, so it only bites synthetic indices,
not 6-char forex pairs, making it easy to miss in testing.

**How to apply:** when adding/auditing any `symbol: z.string()...` in assistant or
trade routes, confirm the max is ≥ 64 and matches the candles/data path so a
symbol that charts can also be read/explained.
