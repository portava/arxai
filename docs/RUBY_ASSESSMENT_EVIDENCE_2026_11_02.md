# Chart assessment evidence binding — 2 November 2026

Application commit: `6baaedb8a7f1cd5631415df48cc7e7df6b80dc7b` on `codex/ruby-assessment-evidence-20261102`, based on `2ae75d5e`.

## Problem and resulting behavior

An Eleanor assessment could survive a change in provider, opaque source identity, signed-in user or last closed candle while the selected market and trading plan stayed the same. Eight regressions reproduced this across completed and pending reads (27 existing checks passed).

The server now returns the evidence from its captured primary context, copied before child awaits, with the authenticated requesting user. It does not fetch newer evidence or echo client assertions. Metadata is kept outside prose scrubbing. Missing capture identity is represented as null.

The client rejects positive replies without valid evidence or with a different observed identity. The cache binds registered consumers to immutable evidence keys. Source changes withdraw completed reads and cancel pending authority before aborting transport; late replies cannot restore it. Shared header consumers receive the same conservative restriction. Equivalent input objects and timeframe aliases preserve the existing assessment. Exact-plan and request-order protections remain intact.

Independent review found missing request-argument wiring and mutable expected identity. Both were fixed, with response-mismatch and mutation regressions. The reviewer reported no remaining blocker for this scoped fix.

## Validation

Tests ran on the source committed above; committing did not change application content.

- Full dashboard: 4,760 passed, 12 skipped, zero failed.
- Scanner lane: 429 passed.
- Captured-input backend: 76 passed, zero failed/skipped.
- All four type-check units and both builds passed. Dashboard retains large-chunk warnings.
- Source guards: 85/87. The two failures remain `risky-wording-frontend` and `no-internal-names-user-ui`; all 43 normalized failure header/detail lines match the previously recorded baseline. Three supplemental checks passed separately because the guard chain stops on failure.
- Initial full dashboard run failed 22 interval-contract fixtures because they lacked the new evidence field; the fixtures now provide explicit evidence and all interval assertions remain. Initial focused run had one missing identity-query fixture; corrected by seeding its test user. Initial typecheck hit a local temporary socket permission restriction; approved rerun and final run passed.

Receipts, failing runs and review: `/Users/areyouok/arx-tier1-release/ruby-assessment-binding-20261102/`.

## Limits and next work

This establishes identity matching, not analytical accuracy or a confidence probability. It binds the signed-in user, not every same-user broker-account change. Provider identity plus last-closed timestamp does not detect corrections to OHLC/history at unchanged timestamps. HTF/current-bar revisions and an explicit assessment expiry policy remain separate gaps. Internal store responses remain mutable; no current production writer was found. An older server without evidence will be conservatively refused by the new client.

The screenshots contain claims that differ from current local wording and geometry. The running Replit commit has not been verified; no preview-fix claim is made. No full root CI, database integration, browser acceptance, performance measurement or broker/terminal test ran for this change. Nothing was merged to main, deployed, synchronized to Replit, migrated or enabled. Release remains **not green**.

## Parallel work ownership

The owner launched the performance/speed/scalability/reliability document in a separate chat. This chat retains Truth accuracy and cross-engine evidence consistency. No message was sent to that chat and no coordination agreement is assumed. Preserve this branch, failed performance experiments and exact baseline receipts. Performance changes must not extend stale assessment lifetimes or remove source/user/candle checks. Quiet timing windows must exclude builds and test jobs.
