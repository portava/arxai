---
name: Live fill confirmation vs position mirror
description: A LIVE_FILLED command with a real broker ticket can coexist with a slot-summary/position mirror that does NOT show the position; they are different EA surfaces.
---

# Live fill confirmation vs the position mirror

A live order's **fill confirmation** and the **open-position mirror** are two
independent EA surfaces. Do not conflate them.

- **Fill confirmation path:** EA executes the queued command and reports the
  terminal result back via the command-result endpoint. After the result-forward
  fix, that result is propagated into `arx_live_commands` (status, broker_ticket,
  mt5_retcode, broker_message, executed_volume). On a healthy bridge this lands a
  few seconds after dispatch (`result_recorded_at` ≈ dispatch + ~4s). This is the
  authoritative "did it fill" signal.
- **Position mirror path:** `arx_live_positions` (which feeds `/me/live/slot-summary`
  and every "open positions" view) is populated by a SEPARATE EA position-sync
  push. That push can be stale for days even while the command path is live —
  e.g. a fresh EURUSD `LIVE_FILLED` (real ticket, retcode 10009) while
  slot-summary still shows only days-old synthetic rows and a phantom-inflated
  negative freeMargin.

**Why:** verified live — a fresh EURUSD market fill (real ticket, terminal
retcode) was confirmed on the command path within seconds while
`arx_live_positions` had no row for it and its newest synced row was days old.
The two surfaces are pushed independently and drift apart routinely.

**How to apply:**
- Judge a live fill ONLY on `arx_live_commands` (real broker_ticket + terminal
  retcode), never on slot-summary/position-mirror presence. Absence in the mirror
  is NOT a fill failure — it's position-sync lag/staleness.
- slot-summary balance/equity/freeMargin are only as fresh as the last
  position-sync; treat deeply-negative freeMargin + huge synthetic lots as a
  stale/phantom mirror, not real broker margin.

# Clean live-proof recipe (avoids the 10016 trap)

A no-SL/TP **market** order is the clean way to prove the live path end-to-end.
The earlier XAUUSD test rejected with broker retcode 10016 "Invalid stops"
because it carried stops too close to market. With an OWNER-unrestricted profile
SL is not required (the `/trades/live-shared/execute` short-circuit and gate #16
both pass without it), so an empty-SL/TP market order reaches `OrderSend` and
fills, with no stops to be rejected. Use `/trades/live-shared/validate` first —
it drafts + immediately cancels (never reaches the broker) to confirm preflight
without consuming the live order.

# Position-mirror honesty rules (slot-summary + /me/live/positions)

When the mirror IS read, four honesty rules keep it from lying:

- **Per-row freshness is absolute wall-clock, never relative-to-newest-row.**
  `FRESH` iff `now - lastSyncedAt <= window`; null sync = `MISSING`. A relative
  floor (newest − window) marks a whole batch of equally-old rows FRESH, so a
  dead bridge's days-old rows would falsely read fresh.
- **Hide-on-absence needs a complete-snapshot marker, NOT row recency.** A
  stale/missing row may be dropped from the open view ONLY when a reliable
  recent COMPLETE sweep excluded it. Drive "reliable" off a per-bridge marker
  (`mt5_connection.last_positions_snapshot_at`) stamped on EVERY positions
  ingest **including an empty list (flat broker)** — never off the newest row
  timestamp. **Why:** when the broker goes flat the EA pushes an empty snapshot,
  no rows get re-stamped, so a row-derived reliability signal decays to "stale"
  and pins genuinely-closed rows on screen forever; the empty-push marker is the
  only server-side proof a sweep actually landed. When the marker is stale (EA
  delayed/offline) keep ALL open positions visible + "Position sync incomplete —
  waiting for broker confirmation". The one unprovable case is an EA pushing a
  genuinely PARTIAL non-empty list — that violates the complete-list contract
  and cannot be detected from payload contents alone.
- **Margin estimation is forex-only.** The 100k-notional formula is valid ONLY
  for fiat pairs; apply it to synthetic indices/metals/crypto and you fabricate
  a wildly wrong margin. Classify forex by requiring BOTH halves in a fiat
  allowlist (a bare `/^[A-Z]{6}/` false-positives XAUUSD/BTCUSD). Non-forex
  contributes 0 and flips `marginEstimateIncomplete=true` (surface the caveat).
- **The live slot bridge must exclude demo.** Pick non-revoked + latest
  heartbeat AND `accountType != demo` — but `ne(col,'demo')` drops NULLs under
  SQL three-valued logic, so OR-in the null case to keep unclassified live
  bridges.
- **command→position link backfills on UPDATE, not just INSERT.** A snapshot
  landing before the command reaches `LIVE_FILLED` inserts unlinked; re-run the
  exact `(userId,brokerTicket,LIVE_FILLED)` match on later updates when still
  null. Never overwrite an existing link; never fabricate one.

**Forex passthrough:** the per-user symbol directory is often empty
(`/me/mt5/symbols` count 0); resolve-symbol still answers off a stale snapshot.
For EURUSD that's fine — broker symbol == "EURUSD" verbatim, so canonicalization
falls back to the provided string. A market order ignores the stale snapshot
price entirely (broker fills live), so "don't use a stale snapshot" is satisfied
by choosing market + no stops, not by needing a fresh quote.
