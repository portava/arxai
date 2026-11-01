# Native chart studies — 1 November 2026

Application: `650c4728`. Development renderer foundation only; not registered as the Scanner adapter, not deployed and not release-green.

## Delivered behavior

The ARX-owned Canvas viewport now renders the existing 23-kind study catalogue through the existing StudyCalculator and preference validator. Indicator mathematics, evidence qualification and volume/profile policy are reused. The layer adds price overlays, oscillator panes, line/histogram styles, reference levels, canonical timestamp inspection, qualified volume/VWAP and explicitly estimated volume profiles. Heikin Ashi, logarithmic, percent and inverted display modes do not change the underlying study input.

The panes share a time axis and navigation. Oscillator hovering returns no price suitable for a trade. Missing evidence withdraws values rather than substituting volume. Context reset withdraws old data; disposal releases calculations; insufficient height is an explicit unavailable state instead of silently dropping configured studies.

Independent review found and corrected offscreen histogram extrema affecting visible scales, fractional boundary scaling (including logarithmic intersections and null gaps), stale hover/gesture state after scale ownership changes, retained calculators after disposal and large-array argument overflow. Pane labels use the reserved price gutter rather than covering study lines. Failures and source hashes are retained.

## Validation

Final combined focused lane: 199 passed, zero failures, comprising 69 price, 51 viewport, 25 axes and 54 study tests. These ran on the exact source committed as `650c4728`. The catalogue checks compare against the existing calculator; they do not prove numerical agreement with broker/competitor software.

The local synthetic browser harness passed seven study groups and all 13 prior viewport groups with no page exceptions. Desktop and 390px/DPR2 mobile images were inspected. This checks five starter studies, qualified synthetic volume/profile rendering, evidence withdrawal, display transforms, oscillator navigation and touch. It is not actual Scanner or terminal acceptance.

Eight counterbalanced timing batches used 20,000 synthetic bars and 200 visible bars, alternating no studies/five studies at normal/4x CPU. With five studies, range-change to completed Canvas RAF submission p95 was 17.6–18.0 ms normal and 18.0–18.3 ms throttled; the worst 27 ms sample is retained. Full-history synchronous preparation p95 was 8.5–10.5 ms normal and 34.7–35.1 ms throttled. Initial five-study setup took 44.3/46.3 ms normal and 156.8/151.9 ms throttled. **Initial setup is not instantaneous and can block a frame.** Retained full-history preparation and first-study calculation costs remain optimization work. This is not physical paint, actual app first-click timing or a competitor benchmark; RAF scheduling can dominate the interaction measurement. All raw samples/outliers are saved.

Full dashboard on `650c472801b02cfa7ae296c00e5daabcec271585`: **4,137 passed, 11 skipped, zero failed**; 236 passing files and one skipped. Dashboard typecheck and production build pass; existing chunk/module warnings remain. Architecture guards: **85/87**, with the same 38 wording and three internal-name findings; failure blocks differ only in the scanned-source count (2,719 to 2,720). Independent source review is clear. Full root/API/database lanes were not rerun for this chart-only foundation.

Raw receipts: `/Users/areyouok/arx-tier1-release/native-chart-studies-20261101/`. The validation archive retains initial failing tests, browser launch failures, all timings and final screenshots. The local test browser and loopback server were closed. Bundle metadata confirms the lab contains no external chart implementation.

## Remaining gaps

The existing app adapter remains selected. Full native adapter integration, drawings/editing, source-bound scanner and trading overlays, linked views/replay, all consumers, price-axis gestures, real Scanner acceptance and removal of the old dependency remain pending. A lab result is not the user's first-click result. Slower-device Scanner failures, native account timing/continuity, Truth consistency and the wider launch goal remain open. No TradingView/MT5 parity, speed superiority or completion percentage is claimed.

No main merge, deployment, Replit change, database migration, worker activation or terminal/broker test occurred.
