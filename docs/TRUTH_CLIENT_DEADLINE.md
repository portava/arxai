# Truth advice deadline

This small follow-up is stacked on PR #90 (`7815a6a4`). It ports the four frontend runtime/test hunks from `bb7293f4`; the separately reviewed server Truth work supplies the optional `validUntil` field. No server or scanner prerequisite is copied into this branch.

The client uses the earlier of its existing 30-second advice horizon and the server's component/bar deadline. A supplied malformed deadline withdraws advice; it cannot extend the client cap. Old server responses without the field retain the existing behavior. Expiry uses the existing shared deadline subscription, including clock, focus and visibility resumption, with no new polling loop or per-row timer.

Correctness acceptance covers early expiry at the exact boundary, malformed and expired deadlines, a later deadline that must not extend the client horizon, old-server fallback, and actual hook updates without another network response. These are advisory display rules, not execution authority.

The original combined implementation was validated in `/Users/areyouok/arx-tier1-release/server-truth-component-evidence-20261026/`. This narrow port has its own commands, source-equality proof and results in `/Users/areyouok/arx-tier1-release/truth-deadline-review-20261026/`. The original server processing benchmark is not a frontend latency measurement. This change adds a bounded timestamp comparison to existing expiry scheduling; no TradingView/MT5 speed or feature parity is claimed.

The server contract follows the distinction between an observation and its computation time, consistent with [TradingView's realtime and confirmed-bar discussion](https://www.tradingview.com/pine-script-docs/concepts/repainting/) and [MQL5's unfinished current-bar convention](https://www.mql5.com/en/docs/series/copyrates). This client change enforces the supplied observation-derived deadline; it does not establish that a market feed is available or authorize trading.

End-to-end early expiry requires both the server Truth change and this client follow-up. Each remains compatible with the older opposite side, but this compatibility is not a claim that an older server emits early deadlines or an older client consumes them.
