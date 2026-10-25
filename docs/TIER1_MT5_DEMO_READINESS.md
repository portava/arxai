# MT5 DEMO readiness — 2026-10-25

Owner selected **MT5 DEMO setup on this Mac**, without authorizing orders. PR #70 is merged
at `d0508e52c6de6e23bf2df9cc297713beebbd359e`. The current target is the unpublished
Replit development workspace **ARX AI baseline import**, under `@portavainc`.
The last read-only inventory found zero MT5 and zero Broker Hub connections.

## What the connection kit establishes

The download, manifest and setup page now select the same source-controlled EA:
`ReplitMT5BridgeEA_v129.mq5`. File sizes and SHA-256 hashes identify the downloaded
files. The kit includes a credential-free profile with read-only mode on and all
trading arms, remote configuration and self-update off. Missing package files
abort the ZIP instead of returning a partial kit.

The package is for read-only connectivity. It is not an EA compilation result,
a broker account connection, or a successful order-validation run. The existing
v1.29 EA source and execution behavior have not been changed by this setup fix.

## Execution incompatibilities found in source

| EA family | Evidence | Consequence |
|---|---|---|
| Legacy v1.27–1.29 | DEMO `CLOSE_POSITION` calls `PositionClose(ticket)` without using the requested volume. | A requested partial close closes the whole position. Do not run the lifecycle validator with this EA. |
| DemoExec v1.30, PendingOrders v1.40, Universal v1.50–1.54 present in this repo | Poll the generic `/api/mt5/commands` mailbox. | They are not drop-in consumers for `/api/mt5/demo-commands-poll`, which the validator uses. |
| Operator-managed v1.55 mentioned in historical docs | Source absent from this repository; no connection in the target workspace. | Historical reports do not establish compatibility or current readiness. |

The validator now refuses known incompatible versions in preflight, before
opening a position. This deny list does not certify unknown/custom EA versions;
the ordinary ownership, DEMO, freshness, consent, safety and snapshot checks
still apply. Do not bypass a refusal by changing the reported version.

## Required next evidence

1. On the selected Mac, privately sign into the intended DEMO
   account. Use the desktop MT5 terminal, not the web terminal/Strategy Tester.
2. The owner creates and privately installs one per-user connection token using
   the supplied read-only instructions. Keep platform controls unchanged.
3. Record actual MetaEditor compilation, fresh owned heartbeat, DEMO account
   classification, complete position/account snapshots and masked symbol rules.
4. Correct and compile a DEMO execution bridge that uses the validator mailbox,
   respects close volume, reports real fill/modify results and preserves safety
   and replay protections. Verify both partial and full close behavior before
   permitting an external lifecycle run.
5. Establish fresh quotes and candles during the broker's open session.
6. Obtain separate approval for a bounded DEMO lifecycle and its necessary
   control changes. All seven scenarios require broker observations, not just
   acknowledgements. `validate:broker` without `--run` only prints the plan.
7. Production publication, persistent worker hosting, production database
   verification and alert/email delivery remain separate outstanding work.

The architecture map is [ARCHITECTURE_MAP.md](ARCHITECTURE_MAP.md); the owner
runbook is [TIER1_OWNER_RUNBOOK.md](TIER1_OWNER_RUNBOOK.md). Existing architecture
scores remain scoped to their measured commits. This report makes no operational
100% claim and creates no broker orders.

## Verification of this setup change

- 46 focused regression tests pass (package integrity, private-token boundary,
  validator consent and broker evidence checks).
- API and dashboard type checks pass; 87/87 architecture/safety guards pass.
- Production API and dashboard builds pass in the approved Replit development
  workspace. These builds do not publish the app or compile MQL5.
- Independent ZIP extraction and CRC checks pass; the kit contains seven files.
- No EA source, broker account or execution-control setting was changed.
