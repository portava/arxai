# COMMAND — INVESTIGATE: IS THE "MISSING" FEED-CACHE COSMETIC OR CAUSAL? (read-only)

Read this entire command before doing anything. This is a **READ-ONLY** investigation — do NOT edit code, do NOT change anything, do NOT "fix" what you find. The goal is to determine ONE thing so the right fix can be chosen: when the symbol picker shows a per-symbol feed status of `MISSING` (the cold-cache state before anything has read that symbol's feed), is that **display-only** (the symbol is still fully tradeable; the trade/dispatch gate resolves live-feed freshness independently) or **causal** (a genuinely-live symbol can be BLOCKED from trading, or shown as un-tradeable, solely because its picker cache entry is cold)? Report the answer with file:line proof. Do not propose or apply a fix — that's a separate decision based on what you find.

## BACKGROUND (what's already known)
- Owner Unrestricted Live user; the symbol allowlist gate passes every symbol (empty `allowedSymbols` = all allowed). Not a restriction.
- The real live-trade gate is per-symbol live-feed confirmation (won't place a real-money entry on a stale/absent feed) — this is CORRECT and must NOT be weakened.
- The picker shows `freshness: "MISSING"` for a symbol until something reads/subscribes that symbol's feed. Observed: symbols showed `tradeable: true` even while `MISSING`, which SUGGESTS (not proves) display-only. Confirm it.

## THE DECISIVE QUESTION
Does the trade-dispatch / "can I place a live trade on this symbol" logic ever consult the PICKER's cached per-symbol feed-status value (the thing that reads `MISSING`), or does it INDEPENDENTLY resolve live-feed freshness at dispatch time from the real feed state (the feed verdict / sufficiency resolver used by the pipeline)?

- If dispatch resolves freshness INDEPENDENTLY and never reads the picker cache → `MISSING` is **DISPLAY-ONLY / cosmetic**. A cold cache cannot block a live-feed-clean symbol.
- If dispatch (or the pre-trade "tradeable?" gate) READS the picker cache value and treats `MISSING` as not-live → `MISSING` is **CAUSAL**. A cold cache can produce a false block on a genuinely-live symbol.

## STEP 1 — LOCATE THE TWO THINGS (read-only)
1. **The picker feed-status cache** — where the `MISSING` value is produced and stored. Find the source of the per-symbol `freshness`/feed-status field the picker/`/api/me/symbols` returns (the thing that reads `MISSING` when cold). Identify the exact field and the cache/service that populates it.
2. **The live-feed gate at dispatch** — the gate in the live pipeline that enforces per-symbol feed confirmation before a real-money entry (the one that refused the V75 order when the feed was down). Find where it resolves the symbol's live-feed freshness and what source that resolution reads.

## STEP 2 — TRACE THE DEPENDENCY (the crux)
- Determine whether the dispatch gate's freshness resolution and the picker's `MISSING` cache are the SAME source or DIFFERENT sources.
- Specifically: does the dispatch gate call the picker cache / the same `/api/me/symbols` field, OR does it call the pipeline's own feed-verdict/sufficiency resolver (e.g. `resolveSymbolFeedVerdict` / the freshness ladder) that reads the actual provider/feed state at dispatch time?
- Also check the pre-trade "tradeable" determination the UI uses to enable/disable the trade CTA: does IT read `MISSING` and disable the button, or does it read the real feed state? (A cold-cache `MISSING` disabling the CTA on a live symbol would also be a causal UX block, even if dispatch itself is independent.)
- Quote the exact lines: what the dispatch gate reads, what the CTA-enable logic reads, and whether either path touches the `MISSING`-producing cache.

## STEP 3 — CLASSIFY
State plainly, with file:line proof, which it is:
- **COSMETIC:** dispatch + CTA both resolve freshness independently of the picker cache; `MISSING` only affects a display label. A cold cache cannot block or disable a genuinely-live symbol. (Then the fix, separately, would be pure UX: relabel `MISSING`→"checking…" and/or warm the cache on picker open.)
- **CAUSAL:** dispatch and/or the CTA-enable logic reads the `MISSING` cache value and treats cold-cache as not-live, so a live-feed-clean symbol can be blocked/disabled purely because its cache is cold. (Then the fix, separately, would be to make the picker cache non-authoritative for trade decisions — dispatch already resolves freshness itself — so a cold cache can never block a live symbol; the safety gate stays intact because it reads the REAL feed state.)
- **MIXED/UNCLEAR:** if e.g. dispatch is independent but the CTA reads the cache, say so precisely (dispatch-safe but UX-blocking).

## NON-NEGOTIABLE
- READ-ONLY. No code change, no fix, no build run needed (just reads/greps). If greps mangle tokens (known issue), read the files directly for the decisive lines rather than trusting snippets.
- Do NOT weaken or alter the live-feed confirmation gate. This investigation must not touch it — the point is to confirm the gate reads the REAL feed state, not to change it.
- Do not warm caches, do not place trades, do not modify the picker.

## FINAL REPORT
- The picker `MISSING` cache: file:line where the value is produced and what field it populates.
- The dispatch live-feed gate: file:line, and what freshness source it reads.
- The CTA-enable "tradeable" logic: file:line, and what it reads.
- Verdict: COSMETIC / CAUSAL / MIXED, with the exact lines proving whether any trade-decision path reads the `MISSING`-producing cache.
- A one-line statement of which fix would apply (UX relabel vs make-cache-non-authoritative) — but do NOT implement it; this is investigation only.

## COMPLETION STANDARD
- The verdict (cosmetic / causal / mixed) is stated with file:line proof showing whether the dispatch gate and the CTA-enable logic read the `MISSING`-producing cache or resolve feed freshness independently.
- The live-feed confirmation gate is confirmed to read the REAL feed state (not weakened, not touched).
- No code changed; the applicable fix is named but NOT implemented.
