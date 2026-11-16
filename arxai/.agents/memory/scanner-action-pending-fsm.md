---
name: Scanner Action-cell bounded pending FSM
description: Header ACTION verdict must never hang on "Checking…" — keyed timeout + error publish rules
---

The scanner header's Action cell shows PENDING ("Checking…") that is only cleared by a Focus-tab scalp publish under `symbol|1m`. Any UI cell whose resolution depends on a publish from another component MUST be bounded:

- **Rule 1 — keyed timeout:** while the display resolver returns PENDING, run a `setTimeout(PENDING_RESOLVE_TIMEOUT_MS)` keyed by `symbol|timeframe`; on expiry downgrade to the honest final `NO_CONFIRMATION`. A key switch restarts the window (no cross-key expiry); a resolved verdict cancels it.
- **Rule 2 — error publishes:** every mutate call that would eventually publish a verdict MUST also publish on `onError` (`CHECK_FAILED` marker) so failures surface immediately instead of waiting out the timeout.
- **Rule 3 — display-only:** NO_CONFIRMATION / CHECK_FAILED are display states in `scannerActionability.ts`, never execution gates. Consumers that only understand real verdicts (feed-cap resolver in BroadScanOpportunityMap) must sanitize `CHECK_FAILED` → null before calling.

**Why:** the header PENDING had no timeout and no error path — on any non-Focus tab, non-1m timeframe, or AI-read failure it hung on "Checking…" forever.

**How to apply:** when adding a new publisher/consumer of the selected-action store, keep the store type `PublishedScannerAction` (verdict OR CHECK_FAILED), route display through `resolveSelectedSymbolActionabilityDisplay(lifted, dataOnly, pendingExpired)`, and never add a second unbounded pending source. Tests locking this: describe(13) in scannerTruthRegression.test.ts + timer render tests in ScannerHeaderSummary.action-timeframe.test.tsx.
