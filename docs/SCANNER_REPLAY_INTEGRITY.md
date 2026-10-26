# Scanner closed-window freshness and correctness replay

Date: 2026-10-26. Stacked on saved scanner views PR #81 (`05aceca0`). This change is limited to scanner input preparation and its offline regression harness.

## Defect and behavior

The scanner excluded forming and future candles before computing its signal, but measured freshness from the original unfiltered provider response. A constructed test kept 60 old closed candles unchanged and appended one future candle: the previous raw trailing gap changed from 4 to -10, turning the shared feed verdict from AWAITING to LIVE. A current forming tip could similarly conceal missing recent closed history.

Freshness now comes from the same accepted closed window used by the signal, features and regime. Input preparation uses one captured clock and the requested timeframe's duration. It first applies the existing provider open/close timestamp convention and validates symbol/source/candles, then measures elapsed intervals from the newest accepted bar's actual open time. Shared clean/delayed/stale thresholds remain unchanged. Re-fetching old bars cannot reset their age.

The actual bar anchor matters: for an H1 session opening at :30, a closed bar remains one interval behind until the next :30 close is due. Flooring to UTC hours would incorrectly mark it delayed partway through the current bar. The scanner does not guess exchange schedules, repair gaps or synthesize missing bars. Session-market gaps remain explicit; continuous-market gaps still restrict analysis to the newest contiguous tail. Calendar-dependent month/week durations retain the existing repository timeframe contract; no new exchange calendar is claimed.

The shared chart raw-gap helper is unchanged. Its handling of future raw timestamps was separately reported to the chart workstream. The selected chart's existing conservative feed cap remains in place on the UI.

## Deterministic correctness harness

`scannerReplayIntegrity.test.ts` runs the real scan path with isolated candle/quote seams, a fixed clock, explicit source identity and reset regime state. Advisory reads return no advisory, preventing live database reads or audit writes. Every candle/quote in this suite is explicitly constructed test data, not a recorded market observation.

The harness verifies:

- MT5 open-time and assistant close-time feeds keep stale closed history limited when a forming or future price shock is appended.
- Future-only, malformed and conflicting inputs cannot create readiness.
- Original history ages even when a fresh quote and another response arrive.
- A :30 H1 session boundary stays current until the next actual close; newly closed history restores freshness.
- Session gaps are not padded and continuous gaps cannot borrow older bars to satisfy the minimum depth.
- Source changes do not carry regime confirmation between bridges.
- Five sequential as-of cuts across three named input streams produce identical base signals, feature hashes, scores and categorized ranking with repeated replay, reordered requests and mutated valid future suffixes. Input arrays remain unchanged. Lateness stays unknown when not supplied; the harness does not invent entry-timing evidence.

Malformed future input is deliberately a fail-closed refusal, so strict prefix equality applies to valid future suffixes. This is a containment contract, not acceptance of corrupt data.

## Verification and evidence limits

The scanner integrity suite, scanner quality/concurrency suite, existing truth/feature/regime/pattern/freshness tests, workspace types, API build and architectural guards are run in an isolated environment. The receipt records final counts and the reviewed commit at `/Users/areyouok/arx-tier1-release/scanner-replay-integrity-20261026/receipt.json`.

No checked-in recorded OHLC/quote dataset was found. Existing fixtures construct candle arrays. The harness therefore establishes reproducibility and no-lookahead behavior for those cases only. Full historical replay would additionally need captured provider identity, observation/ingestion timestamps, quote/spread, point-in-time news, agent registry/governance and history inputs. None is fabricated or fetched from a broker here. This work makes no profitability, predictive-quality, latency-comparison or TradingView/MT5 parity claim.
