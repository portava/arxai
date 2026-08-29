---
name: Mission (and agent) intent attribution tags
description: How additive ownership tags on InstantTradeIntent behave and where their authoritative lock lives
---

# InstantTradeIntent attribution tags (missionId, selfTradeAgentId)

`InstantTradeIntent` carries optional additive ownership tags — `missionId`,
`selfTradeAgentId` — stamped on the OPEN intent and on every exit intent
(CLOSE / PARTIAL_CLOSE / MOVE_BREAKEVEN, each `source:"mission"`).

**Rule:** these tags are pass-through audit metadata ONLY. `executeInstant` never
reads or branches on them, so they can add no gate, weaken nothing, and create no
second execution path. A mission still dispatches solely via
`executeInstant(source:"mission")` → live command pipeline → 23-gate dispatch.

**Why:** attribution had to be possible without introducing a gate or a parallel
path. Durable attribution already lives in `mission_trade_drafts` + the journaled
`commandId`; the intent tag is only extra provenance riding the existing seam.

**How to apply / where to verify:**
- The authoritative lock is a behavioral assertion on the built intent
  (`intent.<tag> === <value>`) at the injected-executor spy in the DB-backed
  integration route tests — the only place an `InstantTradeIntent` is actually
  built and observable.
- Do NOT trust the static CI guard as proof the tag is present: its required
  anchor is a file-level token scan (the token appearing anywhere satisfies it),
  which a refactor could keep while dropping the tag from the intent object. It is
  defense-in-depth, not the lock.
- Pure domain / serialize / risk tests build no intents, so asserting the tag
  there is padding — skip them.
- A new mission dispatch surface must both stamp the tag in the intent object AND
  add the intent-spy assertion in its DB-backed route test.
