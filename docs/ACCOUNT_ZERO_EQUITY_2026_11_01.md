# Account-shell zero equity correction — 1 November 2026

Application commit: `4f48789ff909b27fefd3ccfc16d70d7d840d1390`.
Base: `6f1794eabe817fc6183ed222d7a1cd74801cb7c1` (includes shared-account stalled-read recovery).

## Correction

Two truthiness fallbacks changed a computed virtual-ledger equity of zero into the account balance. A virtual balance of 1,000 with equity of zero was returned as equity of 1,000. Both fallbacks now preserve the computed equity. Negative and positive equity, allocation principal plus P/L, user scoping and trading gates retain their existing behavior.

This is the allocation ledger, not a new native broker reader. It does not make allocation balances equivalent to the whole MT5 account. Existing missing/non-finite inputs, allocation currency assumptions, mixed-account aggregation and personal native-report coverage remain separate gaps.

## Evidence

- Five tests execute the complete source `computeAccountShell` function with inert dependencies. On the original application source, two zero-equity regressions failed and three cases passed. After the correction all five pass. Scope assertions and the recursive-reader guard also execute.
- The existing account-snapshot test command now includes those cases. On application commit `4f48789f`: **54 passed, 0 failed, 0 skipped**. This is source-function and projection testing, not an HTTP, database or terminal integration run.
- API build passes on identical application source; API typecheck passes after generating isolated DB/Zod declarations. Receipts are retained separately.
- Guards: **85/87**. Both failure blocks are byte-identical to the prior account-refresh baseline: 38 risky-wording findings and three internal-name findings.
- Independent read-only review found no scoped blocker. The reviewer inspected the source and test design; it did not independently rerun the tests.
- Initial surrounding-suite attempts failed because the isolated checkout lacked the `api-zod` dependency link. Initial typecheck required generated DB/Zod declarations. These setup failures are retained, not omitted.

## Remaining real-time requirements

The owner's requirement remains: changes made on the same MT5 account by any trader must promptly reach every authorized ARX view; balance, equity, native account profit, credit and margin must retain account identity, currency, precision and observation time. Old or unverified observations must never be presented as current money.

Not yet proven: terminal-to-screen timing, producer continuity and clock correctness, cross-process notification delivery, personal native account coverage, all-surface reconciliation and browser acceptance. The current producer's one-second sampling and periodic delivery recovery are not a zero-delay guarantee. No real-time parity or launch readiness is claimed.

Development branch only. No main merge, deployment/Replit update, existing database change, worker activation or terminal/broker test occurred. Original Smart Chart and competitive work remains open and is preserved in its separate worktree.

Raw receipts: `/Users/areyouok/arx-tier1-release/account-zero-equity-20261101/`.
