# Truth evidence classes

The owner brief asks the Truth system to "distinguish verified information, estimates, stale data, and unavailable information." Before this change, the Truth snapshot (`GET /api/me/market/truth/:symbol`) carried one feed-level `data.state` (`LIVE_CONFIRMED | SYNCING | STALE | UNAVAILABLE`). No individual claim said whether it was an observation, a calculation, stale, or missing. A user could not tell whether the displayed price, the scanner vote, the entry/stop/target or the overall read was observed or estimated.

This change is additive and advisory. It labels what surfaces display. It does not gate, slow, permit or place a trade. Execution, arm, kill, broker and account gates remain separate authorities.

## Contract

`SymbolTruthSnapshot.evidence` (OpenAPI `MarketTruthResponse.evidence`, optional on the wire) classifies each claim:

| Claim | Source field(s) |
| --- | --- |
| `price` | `data.price` plus the bar it came from (`data.lastCandleAt`) |
| `lastCandle` | `data.lastCandleAt` |
| `lastTick` | `data.lastTickAt` |
| `news` | `news.providerConnected` |
| `components.{scanner,flame,timing,scalp}` | `components.*.present` / `asOf` |
| `levels` | `levels.withheld` plus the scanner read's observation |
| `verdict` | `verdict.bias` plus the present components' observations |

Each claim has this shape: `{ evidenceClass, reason, observedAt }`.

- `evidenceClass`: `verified` > `estimate` > `stale` > `unavailable`.
- `reason`: a machine-readable code. Each code belongs to exactly one class, and a mismatched class/code pair is treated as malformed.
- `observedAt`: the data timestamp the claim rests on, or `null`. It is never the build or read time. For price and last candle it is the feed's candle close boundary. That boundary can be the scheduled end of a forming bar: it identifies the bar and does not prove the bar is final. For the verdict it is the **oldest** observation among the present components.

### Classification rules (`lib/domain/src/truth/evidenceClass.ts`)

- **verified**: `LIVE_FEED_OBSERVATION`. Only direct observations (price, last candle, last tick) qualify, and only from a `LIVE_CONFIRMED` feed that has an identified source and a parsable observation time.
- **estimate**:
  - `MODEL_ESTIMATE`: every component vote, the entry/stop/target geometry, grades and the composed verdict. These are ARX calculations, so they are never `verified`, even when every input is fresh.
  - `FEED_UNCONFIRMED`: values observed while the feed is `SYNCING`.
  - `CALENDAR_FETCH_TIME_UNKNOWN`: a connected calendar. The snapshot does not carry the calendar's fetch time, so news is never labelled verified.
- **stale**:
  - `FEED_STALE`: the feed is past its freshness budget. Derived claims follow their feed.
  - `EXPIRED`: the read passed `validUntil` inside the server cache window. In that case `capExpiredTruthSnapshot` marks the derived claims stale and leaves data claims unchanged.
- **unavailable**:
  - `NO_FEED`: no source, or the feed is `UNAVAILABLE`.
  - `NO_VALUE`
  - `NO_OBSERVATION_TIME`: a value exists, but no observation is attributed to it.
  - `INVALID_TIMESTAMP`: the time is unparsable, or the tick time is more than 5 s in the future.
  - `NO_CALENDAR`: no economic calendar is configured.
  - `CALENDAR_UNCHECKED` (added 2026-10-27 review follow-up): scheduled event risk could not be checked. Either the calendar read failed, or a configured calendar is not connected. The snapshot's new `news.riskUnchecked` flag drives this reason, and the risk label and disclaimer use the same "could not be checked" wording. Before this, the claim said "No economic calendar is connected." while the label said the calendar could not be checked. The flag is optional on the wire. When an older server omits it, the reason falls back to `NO_CALENDAR`. If a server reports a calendar claim at `estimate` while setting `riskUnchecked`, the client downgrades that claim.
  - `COMPONENT_ABSENT`
  - `LEVELS_WITHHELD`
  - `INSUFFICIENT_DATA`: the verdict bias is `UNKNOWN`.
  - `UNCLASSIFIED`: the client received a malformed claim.

  Absence is never coerced into a value.

A derived claim can never outrank the feed it rests on:

| Feed | Derived claim |
| --- | --- |
| live | estimate |
| syncing | estimate |
| stale | stale |
| unavailable | unavailable |

A future scheduled candle close is accepted as bar identity, because the existing wire meaning of `lastCandleTime` allows it. A future **tick** is not accepted.

### Client cap (`artifacts/trading-dashboard/src/lib/symbolTruthEvidence.ts`)

`resolveSymbolTruthEvidence` first applies its existing cap, which can withdraw a snapshot or neutralize components, levels and verdict. It then calls `capSymbolTruthEvidenceClasses`:

1. It re-classifies the snapshot as it will be displayed.
2. Each claim takes the **weaker** of the server class and this local class (`downgradeTruthEvidence`). The client can downgrade a class but never promote one. On a tie, the server claim stands.
3. Malformed server claims become `unavailable/UNCLASSIFIED`.
4. A missing or non-object `evidence` (an older server) yields no classification. The UI then renders nothing instead of inventing labels.
5. When the classes are unchanged, the same snapshot object is returned, so the existing referential-identity behaviour is preserved.

`useSymbolTruth` exposes the capped `evidence`.

### UI

`TruthEvidenceClasses` (`components/scanner/TruthEvidenceClasses.tsx`) is mounted in the Ruby Market Read card. It appears in every body state, including while a directional read is withheld, so "unavailable" is stated rather than hidden. It is a disclosure titled "What's observed vs estimated" with a count per class. Each of the ten claims gets a plain-English row: the class, the reason text and the UTC data time. Reason codes never reach the copy; the shared English strings live in the domain module (`TRUTH_EVIDENCE_REASON_TEXT`). A footer states that estimates are ARX calculations and that nothing here places or permits a trade.

## What the tests prove

| Suite (root `ci` script) | File | Proves |
| --- | --- | --- |
| `@workspace/api-server test:truth-component-evidence` | `lib/domain/src/truth/__qa__/evidenceClass.test.ts` (11) | Live observations are verified with their data time. Heuristic claims are never verified in any feed state. Feed state propagates (syncing → estimate, stale → stale, unavailable/no source → unavailable). Null, nonpositive and NaN prices, missing bars, invalid stamps and future ticks are unavailable. A future scheduled candle close is allowed. Absent components, withheld levels and unknown verdicts are unavailable. Expiry affects only derived claims. Downgrade takes the weaker class and never promotes. Forged, mismatched or missing server claims are untrusted, and an older server yields null. Reason copy has no internal tokens. Classification is pure. |
| same | `artifacts/api-server/src/lib/truth/__qa__/snapshotEvidenceClasses.test.ts` (7) | Runs the real snapshot composer with offline stand-ins: a live matching read, `observedAt` never equal to build time, a connected calendar classified as an estimate, a stale feed, a failed chart source, classification as a pure function of the visible snapshot fields, and post-cache expiry. |
| `@workspace/trading-dashboard test:truth-evidence` | `src/lib/symbolTruthEvidenceClasses.test.ts` (9) | A confirmed read keeps its classes and object identity. A weaker server class is not promoted. An inflated server class is downgraded without mutating the cache. Every capped scenario (unconfirmed, stale, unavailable) downgrades all claims. An older server gets no invented classes. Malformed claims are rejected. An expired snapshot is withdrawn. |
| same | `src/components/scanner/TruthEvidenceClasses.test.tsx` (6) | Render proof covering plain-English rows, data time, summary counts, stale rendering, no leaked codes, the mount in the Ruby Market Read card while the read is withheld, and no ledger without a classification. |

## Remaining limits

- The snapshot has no calendar fetch time, so news is at most an `estimate`. Adding a provider fetch timestamp would let a connected calendar be verified; that is a separate producer change.
- Tick freshness relies on the feed's own `stale` flag through `data.state`. The snapshot does not add a separate per-tick age budget.
- The snapshot has no separate quote claim. Quote attribution and broker price alignment are being changed in a parallel slice (`brokerPriceAlignment.ts`, `chartTruthScore.ts` and the quote route), which this change does not touch. Chart Truth scores and Ruby's own `/me/market-edge` scores are not classified here. They remain heuristics and are labelled by their own surfaces.
- `observedAt` for price is the bar's close boundary, not a tick time, so a forming-bar price is identified, not proven final.
- The classes describe what this snapshot knows. They do not prove production feed availability, provider latency, execution quality, or parity with any external charting platform.
