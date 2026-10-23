---
name: Flame-stage tests need an ATR baseline
description: Why scalp flame-stage unit tests must set candle range, not just close steps
---

The flame stage classifier separates IGNITING from RUN_ON/STRETCH using
**extension measured in ATRs** (run move ÷ average true range), not raw price
movement. ATR is the mean candle range over the window.

**Rule:** when constructing candle fixtures for a target flame stage, the flat
"baseline" candles must have a realistic range (e.g. ±2 around price), not a
tight one. Too-tight flat candles collapse ATR, so even a small burst inflates
extension-in-ATR past the RUN_ON threshold (stretchAtr*0.6) — your intended
IGNITING window silently classifies as RUN_ON.

**Why:** a fresh-burst test built with ±0.5 flat candles + two +2 steps gave
extension ≈ 3.4 ATR → RUN_ON; widening flats to ±2 dropped it to ≈ 1.1 ATR →
IGNITING, and also pulled chaseRisk down to LOW (chase norm also keys off
extension/stretchAtr).

**Also:** a BLIND flame read (no/short candle window) still receives a non-zero
`scalpScore` — `finalizeScalpVerdict` overwrites it with the overall quality
score for any actionable status. `scalpScore` is scalp quality, not purely the
flame; don't assert it's 0 for blind reads. Assert `blind===true` and
`flameStage==="NONE"` instead.
