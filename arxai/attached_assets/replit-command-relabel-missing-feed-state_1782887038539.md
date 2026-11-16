# COMMAND — RELABEL THE PICKER "MISSING" FEED STATE (display-only, cosmetic)

Read this entire command before changing anything. This is a **DISPLAY-ONLY** UX fix. A prior read-only investigation PROVED the picker's per-symbol `freshness: "MISSING"` is purely cosmetic: it comes from the enumerated broker-directory overlay (`resolveSymbolsForUser.ts:201`, `en?.freshness ?? "MISSING"`) and NO trade-decision path reads it — the live dispatch gate resolves feed freshness independently from the real provider feed (`liveCommandPipeline.ts:596/1505 → resolveSymbolFeedVerdictForSymbol → routeCandles`), and the trade ticket never consumes the picker's `freshness`/`tradeable` fields (it re-gates on submit). So this change touches ONLY what the user SEES. Do NOT touch any trade-decision, dispatch, gate, or feed-verdict logic. Do NOT make the picker cache authoritative for trades.

## THE PROBLEM (cosmetic only)
The picker shows `MISSING` for a symbol until something reads/warms that symbol's feed-cache entry. `MISSING` reads like "no feed / broken," but it actually means "haven't checked this symbol's feed yet" — the symbol is fully tradeable and the real feed gate runs at dispatch regardless. The word causes false alarm ("can I not trade this?"). Fix: relabel to an honest, non-alarming state, and optionally warm the cache on picker open so the real status shows sooner.

## SCOPE — TWO SMALL CHANGES (the second is optional)

### Change 1 (required) — Relabel `MISSING` in the DISPLAY layer
- Find where the picker renders the freshness badge (investigation pointed at `SymbolPicker.tsx:141`, `data-testid="symbol-picker-freshness"`, and the `SymbolMeta` badge/tooltip ~:217-238).
- Where the value `"MISSING"` is shown to the user, render it as a clearer, non-alarming label — e.g. **"checking…"** or **"—"** or **"not yet checked"** (pick one, keep it short and honest; it means "feed status not yet resolved," NOT "unavailable/broken").
- Do this at the DISPLAY/label layer (a label map or a small render helper), NOT by changing the field value `resolveSymbolsForUser.ts:201` returns — keep the API contract's `"MISSING"` value stable in case anything else reads it; only change how it's PRESENTED. (If a shared label map already maps freshness states to display strings, add/adjust the `MISSING` entry there.)
- Make sure the relabel applies everywhere the picker surfaces this state (badge + tooltip + any list/row text), so it's consistent.

### Change 2 (optional — do only if clean and low-risk) — Warm the cache on picker open
- If the picker can trigger a feed-status read/subscribe for its visible symbols when it opens (so their real freshness resolves quickly instead of sitting at `MISSING`), wire that — BUT only if it's a clean, existing capability (e.g. the picker already has a refresh/subscribe hook). Do NOT build a new heavy polling loop, do NOT add a runaway interval, do NOT hammer the feed. If warming isn't cleanly available, SKIP this change — the relabel alone solves the false-alarm.
- If you do warm: it must be a bounded, one-shot resolve on open (not continuous polling), and it must not change any trade gate.

## NON-NEGOTIABLE
- DISPLAY-ONLY. Do NOT touch: `liveCommandPipeline.ts`, `resolveSymbolFeedVerdictForSymbol`, `symbolFeedVerdictForSymbol.ts`, `routeCandles`, any gate, any dispatch/preflight path, or the `tradeable` derivation. The live-feed confirmation gate stays exactly as-is (it reads the REAL feed, correctly).
- Do NOT make the picker cache authoritative for trade decisions — the whole point of the investigation was that it's correctly non-authoritative; keep it that way.
- Keep the API field value `"MISSING"` stable (relabel at presentation, not at the source field) unless you confirm nothing else depends on the literal — safer to relabel in the display layer.
- No new polling/intervals; if warming the cache isn't cleanly one-shot, skip Change 2.

## TESTS / VERIFY
- If a picker render test asserts the `MISSING` text, update it to the new label (and confirm the badge/tooltip render the new string).
- Dashboard typecheck green.
- If you added Change 2: confirm it's a bounded one-shot (no interval leak) and that `ci:guards` still green (nothing in the trade path changed).
- Confirm the diff is limited to the picker display layer (+ optional warm hook) — NOTHING in the live/dispatch/gate files.

## FINAL REPORT
- Where `MISSING` was relabeled (file:line) and the new label used; confirmation it's display-layer only and the API `"MISSING"` value is unchanged.
- Whether Change 2 (cache-warm-on-open) was done or skipped, and if done, proof it's one-shot/bounded (no new interval).
- Confirmation NO trade-decision / dispatch / gate / feed-verdict file was touched; typecheck green; guards green if applicable.

## COMPLETION STANDARD
- The picker no longer shows the alarming `MISSING` to users — it shows an honest "checking…"/"—"/"not yet checked" everywhere that state surfaces.
- Change is DISPLAY-ONLY; the live-feed confirmation gate and all trade-decision paths are untouched and unchanged; the picker cache remains non-authoritative for trades.
- Diff limited to the picker display layer (+ optional bounded warm hook); typecheck green; any picker test updated to the new label.
