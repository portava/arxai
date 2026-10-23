---
name: slot-summary carries the canonical balance block
description: Why /me/live/slot-summary now returns the live block and how doPoll heals detailed balance freshness
---

# Slot-summary canonical balance block

`/api/me/live/slot-summary` (the polling fallback for `useLiveAccountSnapshot`)
returns the canonical mark-to-market balance block under `live`, the SAME wire
shape the SSE `account_snapshot` event sends as its `live` sibling. Both
endpoints project it through the single shared `toInvestorLiveBalanceWire(...)`
over `buildInvestorLiveBalanceSnapshot(userId)` so they cannot drift.

**Why:** A backgrounded tab self-heals via a one-shot poll. Earlier the poll
endpoint did NOT carry the block, so the hook honestly downgraded the carried
detailed balance (realized P/L, available balance, floating P/L) to
"unavailable" — leaving the detailed numbers blanked even when the underlying
data was genuinely fresh. Carrying the block lets the detail heal to real
fresh/stale.

**How to apply:**
- The hook's `doPoll` reads `data.live`, rebuilds the detailed block from it,
  and FORCES `freshness.status` to the verified poll freshness (FRESH→fresh,
  STALE→stale, else unavailable) — it does NOT trust the block's own
  server-stamped status, so the detailed status can never silently disagree
  with the headline `freshness`.
- A stale poll yields a stale (never falsely-fresh) detailed block — honesty
  preserved. Figures come from the same re-verified poll, never fabricated.
- This reverses the earlier "downgrade to unavailable" decision (that decision
  was only because the endpoint didn't carry the block — now it does).
- If you ever add fields to the canonical block, add them in
  `toInvestorLiveBalanceWire` (one place) and the hook's `InvestorLiveBalance`
  type, or SSE and poll will diverge.
