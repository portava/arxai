# Extend candle timeframe enum to the FULL MT5 set (server-side, before EA v1.54)

Supersedes the earlier "add M30/W1/MN1" prompt. The EA is being upgraded to v1.54, which supports all 21 native MT5 timeframes. Extend the pinned server enum to match. This is an enum extension to the existing candle bridge (Task #469 family) — do NOT build any new system, do NOT touch source priority, auth, or the closed-bar finalization rule.

## Canonical enum (21 values)

M1, M2, M3, M4, M5, M6, M10, M12, M15, M20, M30,
H1, H2, H3, H4, H6, H8, H12,
D1, W1, MN1

## Scope — every place the enum is pinned

1. Broker candle schema/validators (lib/db/src/schema/brokerCandles.ts, brokerCandleBackfillStatus.ts). If DB-level enum/constraint: migration. If app-level: validator update.
2. normalizeBrokerTimeframe in brokerCandleStore.ts — add mappings for the new values, including common aliases:
   - "2m"->M2, "3m"->M3, "4m"->M4, "6m"->M6, "10m"->M10, "12m"->M12, "20m"->M20, "30m"/"30"->M30
   - "2h"/"120"->H2, "3h"/"180"->H3, "6h"/"360"->H6, "8h"/"480"->H8, "12h"/"720"->H12
   - "1w"/"W1"/"weekly"->W1
   - "1M"/"MN"/"MN1"/"monthly"->MN1
   CRITICAL COLLISIONS — add explicit tests for each:
   - "1m" (minute) vs "1M" (monthly): case-sensitive for this pair; "1m"->M1, "1M"->MN1.
   - numeric "180": H3 (minutes convention) — pick ONE convention for bare numbers (minutes) and document it.
   - "720" could be M12 in a seconds convention or H12 in minutes — use the minutes convention consistently: "720"->H12, and do NOT map "12" to anything (reject bare ambiguous values not in the alias list).
3. computeBackfillStatus retention targets. Group sensibly:
   - M1: 30d · M2-M4: 30d · M5-M6: 90d · M10-M15: 180d · M20-M30: 1y
   - H1-H3: 2y · H4-H12: 5y if broker has it
   - D1/W1/MN1: max available
4. Ingest validation — all 21 accepted; everything else still rejected.
5. Scanner candle endpoint + router read path — all 21 servable with the same source-priority/quality logic.
6. Frontend Scanner timeframe selector — with 21 options, a flat chip row will not fit mobile. Replace or augment with a compact selector (dropdown, or primary chips [1m 5m 15m 30m 1h 4h 1D 1W 1M] + a "more" menu for the exotic ones). Primary chart set stays one tap. No horizontal page overflow on mobile.
7. Ruby/market-read timeframe handling if it enumerates the pinned set anywhere.

## Tests

- Synthetic ingest accepted for at least M2, M30, H2, H12, W1, MN1 (test-confined).
- Collision tests: "1m"->M1, "1M"->MN1; bare-number convention documented and tested.
- Unknown/ambiguous values still rejected.
- Retention/backfill status computes for new groups.
- Existing six original timeframes unaffected (no regression in the existing candle suite).
- Mobile selector fits viewport.
- Typecheck passes.

## Order of operations

Server ships FIRST. EA v1.54 is installed manually afterward. Confirm in the response that the deployed server accepts an M2 and an MN1 synthetic batch end-to-end.

## Do not

- Do not deploy or modify EA files.
- Do not modify source-priority, auth, or closed-bar finalization.
- Do not break live trading, heartbeat, command execution, or the currently-streaming EURUSD feeds.
