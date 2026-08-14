---
name: Chart symbol shared bus
description: Single source of truth for the currently-selected symbol across chart, ticket, scanner, AI assist, ruby, and market-data router.
---

`artifacts/trading-dashboard/src/lib/use-chart-symbol.ts` is the canonical bus (localStorage `highroll.chartSymbol` + window CustomEvent). Every UI surface that selects a symbol must read via `useChartSymbol()` and write via `setChartSymbol(tvForm)` — never a local `useState` for symbol.

**Why:** when even one consumer holds its own symbol state, scanner/chart/ticket/ruby/AI-assist drift apart, and stale per-symbol setup (SL/TP, AI card, validation) rides into the next user action — at worst, a /validate against the previous symbol.

**How to apply:**
- New "symbol-aware" UI: `const [s] = useChartSymbol(); const sym = bareSymbol(s);`. Dropdowns/pickers call `setChartSymbol(next.tv)`.
- Async work keyed by symbol (loadCard, quote fetch, validate, AI feed) must invalidate in-flight requests when the bus changes. Pattern: `const reqId = ++ref.current; … if (ref.current !== reqId) return;`.
- Modals that take `defaultSymbol` (e.g. `LiveSharedTradeTicket`) need a dedicated `useEffect(..., [defaultSymbol])` that, while `open`, clears SL/TP/validation/ack — otherwise a mid-open chart flip races stale state into the next /validate.
- When a button opens a modal whose variant depends on an async-loaded flag (e.g. `useMasterLiveAccess().canTrade`), freeze the variant at open-time (`openedAsShared = access.canTrade === true`) and disable the button while access is loading. Never branch on the live flag in render — late resolution swaps the modal under the user.
- Static regression: `scripts/src/chartSymbolPropagationTest.ts` asserts every named consumer imports the bus and that ChartTradeEntry routes one-modal to the shared ticket.
