---
name: MT5 retcode → user-copy override rules
description: How a real broker retcode maps to clean user/admin rejection copy without masking more specific reasons or faking success.
---

# MT5 retcode → user-copy override

The live-rejection display (frontend `structuredRejection.ts`) can take a real
MT5 broker retcode (`opts.mt5Retcode`) and turn it into clean user copy
(e.g. 10016 → "your stop loss is too close") plus an admin label
("10016 · invalid_stops"). Rules that must hold:

- **Override copy ONLY for MAPPED failures.** A retcode present in the frontend
  mirror table (`rc.mapped === true`) is the broker's authoritative verdict and
  wins the user copy. An in-range-but-UNMAPPED code resolves to
  `unknown_broker_response` (`mapped:false`) and must NOT overwrite a more
  specific gate/EA code-derived message — it only surfaces its label for admins,
  and is used as copy *only* in the no-code branch (honest broker fallback vs the
  "no detailed reason" state).
  **Why:** an unmapped code (e.g. 10041 LONG_ONLY, which the frontend doesn't
  map but the backend has a specific friendly reason for) would otherwise
  downgrade a precise message to a generic "broker rejected this trade."

- **`classifyRetcode` must reject non-retcodes.** Only positive integers
  classify. Return `{null,null,false}` for non-number/non-string, blank or
  whitespace strings, NaN, decimals, `0`, and negatives.
  **Why:** `Number("")` and `Number("  ")` are `0` (finite) — the old code
  coerced blank to `0` → `unknown_broker_response` and wrongly overrode existing
  copy. `Number.isInteger(n) && n > 0` is the guard.

- **Absent retcode = zero influence.** No retcode → pre-broker (gate/EA)
  rejections keep their exact existing copy (backward compatibility for the
  inline `trackLiveOutcome` callers and the prior structured-rejection checks).

- **Front/back mirror drift is guarded.** `scripts/src/retcodeMapTest.ts` #13
  iterates 10000–10060 and asserts the frontend mirror agrees with the backend
  failure map (`retcodeMap.ts`) for every mapped failure code. The frontend
  cannot import the api-server leaf package, so the table is hand-mirrored —
  this guard is the only thing catching silent divergence.

**How to apply:** when adding/renaming a backend retcode category, update the
frontend `RETCODE_CATEGORY` + `RETCODE_USER_COPY` in lockstep or #13 fails.
Never let the override imply a fill — dispatch≠execution honesty still holds;
this is presentation-only of a rejection that already happened.
