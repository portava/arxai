---
name: EA rejection reason fallback
description: When an MT5 EA rejects a live command, populate rejection_reason from broker_message / mt5Retcode if upstream didn't set it.
---

The Phase B pipeline's `recordLiveCommandResult` previously wrote `brokerMessage` + `mt5Retcode` on rejection but left `rejectionReason` NULL whenever upstream didn't set it. UI then displayed "(none)" for the rejection cause even though the EA had returned a perfectly clean broker reason (e.g. retcode 10027 "AutoTrading disabled by client").

**Rule:** on any non-FILLED outcome, if `row.rejectionReason` is still null, fall back to:
1. trimmed `brokerMessage` when present,
2. else `EA_RETCODE_<n>` when retcode is set,
3. else `EA_REJECTED_NO_DETAIL`.

**Why:** EA-side refusals (terminal AutoTrading off, ReadOnlyMode, capabilities=false, symbol-disabled, margin-call) all come back as retcode + message but never as a `LIVE_BLOCKED:<gate>` reason — that path is server-side only. Without the fallback, the user (and the QA harness) cannot tell a "no detail" rejection from a real broker rejection.

**How to apply:** any new code path that transitions a live command into a rejection terminal state must either set `rejectionReason` explicitly or rely on this fallback. Do NOT branch on `mt5Retcode === 0` as success — `0` is also written for EA-side capabilities refusals where no order ever reached the broker.
