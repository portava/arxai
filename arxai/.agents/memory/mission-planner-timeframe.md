---
name: Mission Planner timeframe unit model
description: Minutes-first flexible timeframe for profit missions — types, math fields, zone classification, NL parser (fully wired).
---

# Mission Planner timeframe unit model

## The rule
Timeframes are now expressed as (amount, unit) where unit ∈ {minutes, hours, days, weeks}.  
The canonical compute currency is **minutes** (`specToMinutes`, `MINUTES_PER_UNIT`).

## Key math insight
Short-timeframe daily-equivalent return is very large even for tiny gains:
- 1% gain in 30 min → requiredDailyReturnPct ≈ 61% → tier = Unreasonable → class = "Unrealistic scalp"
- This is CORRECT math. Tests must assert the zone (Scalp-zone), not a specific mild tier.

## Unit-aware classification zones
| totalMinutes | Class |
|---|---|
| < 60 | Scalp / Extreme scalp / Unrealistic scalp |
| 60–1439 | Intraday / High-risk intraday / Unrealistic intraday |
| 1440–10079 | Swing |
| ≥ 10080 | Multi-day |

## New MissionMath fields
- `timeframeMinutes` — total span in minutes
- `requiredReturnPerHourPct` — linear hourly pace (requiredReturnPct / hours)
- `requiredDailyEquivalentReturnPct` — per-hour × 24

## Route handling
- POST /profit-missions: accept either `timeframeEnd` (legacy) OR `timeframeAmount + timeframeUnit` (preferred)
- DB cols: `timeframe_amount`, `timeframe_unit`, `timeframe_minutes`, `timeframe_label` (all nullable for backward compat)

## NL parser — fully wired
`artifacts/api-server/src/lib/assistant/parseMissionIntent.ts` — pure, IO-free.
POST /api/profit-missions/parse-intent (requireUser, 400 on failure).
UI prefills form fields from the parsed intent; create still goes through the normal create endpoint.

Patterns: "turn $A into $B in N unit", "$A to $B in N unit", "double", "make $P profit from", "grow to/by",
target-only ("scalp this account to $X in N unit" → startingAmount null), "Make $X in N unit" (single-amount
fallback now works because extractTimeframe scans ALL number+unit pairs — not just the first — so "200 in"
doesn't block finding "5 hours"), relative time ("by tomorrow"=24h, "by EOD"=8h, "by EOW"=5d), riskProfile
extraction (conservative/balanced/aggressive/extreme anywhere in text; null if absent).

Directional patterns ("turn $A into $B", "$A to $B") fail-fast on ordering violations — they do NOT fall
through to the reordering fallback. startingAmount is number|null (null = keep current form value).

**Why:** Any sub-hour mission classified as "Scalp" is expected to be Extreme/Unrealistic by the math.
Tests for unit-aware classification must check the zone label set, not a specific mild tier.
