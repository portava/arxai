# Global session label — 2 November 2026

Application commit: `e6ac1db00e5fbdd5fa24c604444a25e17fb7d982`. Base: `16ef319cbe7c3f0c3bc67d4cb780e9ad76a2b7d2`. Release remains not green.

The global header previously inferred Asia/London/New York/Off from the client UTC hour and presented the result as a trading session. It had no selected-market calendar, holiday, DST, or historical-chart qualification. The New York label also used a success tone.

The header now displays neutral **Session: Unverified**. The status drawer preserves the existing fixed UTC clock-window estimate, explicitly labels it an estimate, and explains what it cannot verify. Only the mounted drawer has a minute timer; focus/visibility refresh it, and unmount cleans the timer/listeners. No market hours or strategy policy were invented, and no execution gates changed.

## Validation

- Baseline rendered regression: 4 failures, retained in `before.log`.
- Final rendered session and existing account-reader regression: 8 passed, 0 failed. Includes neutral labels at weekend/day/night timestamps, a connected broker that cannot prove session evidence, minute-boundary update, focus/visibility refresh, no timer before opening details, and timer/listener cleanup on unmount.
- Dashboard typecheck and production build passed; existing large-chunk build warning retained.
- Source guards: 85/87. The 43 normalized failure lines match the prior baseline exactly; existing wording/internal-name guards remain failing.
- Independent static review: no scoped blocker. Reviewer inspected current source/test hashes; did not independently run tests.

Tests ran on the exact two-file tree subsequently committed. Source hashes and raw logs are in `/Users/areyouok/arx-tier1-release/topbar-session-truth-20261102/`.

## Still unproven

This is an evidence-label correction, not verified session/calendar support. No browser acceptance or latency measurement for this change, no physical-device/TradingView/MT5 parity claim. No Replit sync, deployment, database migration, worker/trading activation, or broker tests. Existing unverified broker-mode/status details and wider Truth/competitive gaps are not certified by these tests.
