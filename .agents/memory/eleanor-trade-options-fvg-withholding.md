---
name: Eleanor trade-options FVG withholding
description: Why a feed-unconfirmed assistant chart read must strip numeric FVG levels, and how trade-options intent routes.
---

# Eleanor trade-options structured response

**Rule:** the FVG strategy read's staleness is evaluated *independently* of the
primary chart read's feed verdict. So a feed-unconfirmed (STRUCTURAL_ONLY) read
can still carry fresh numeric FVG levels (entry/SL/TP/invalidation) unless they
are explicitly withheld. The STRUCTURAL_ONLY branch must spread the withheld FVG
block (`withholdFvgLevels`: pure, nulls numeric levels, keeps
direction/stage/narrative); only the VERIFIED + `canShowLiveTradeSetup` FULL
branch keeps real levels.

**Why:** two separate freshness judgments exist for the same symbol. Trusting the
primary read's verdict alone leaks numeric levels the feed can't back — an
honesty violation on an advisory surface.

**How to apply:** when adding/editing assistant read layers or any structured
"trade options" output, gate numeric levels on the read's own verified basis, not
on whether the FVG engine happened to produce a block. The system prompt must
branch on BOOLEAN payload fields (`canShowLiveTradeSetup` / `canReadStructure` /
`liveSetupWithheld` / `fvgStrategyRead.active` / `levelsWithheld`), never on
`readLayer` strings (they get scrubbed in user-facing copy).

**Routing:** trade-options questions are detected by a pure
`detectTradeOptionsIntent(text)` (options/setups/possible-entries/where-to-enter/
how-to-trade/trade-plan; excludes derivatives option-chain, billing/account/nav
"options", own-account performance). It is OR'd with chart-read intent into
`forceStructuralRead`, which only steers turn-0 `tool_choice` toward the
read-only structural tool + telemetry — never dispatch/arming/allocation/gates.
This is display/advisory only; it must never become an execution path.
