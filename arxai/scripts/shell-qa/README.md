# Isolated shared-shell browser regression

From the workspace root:

```sh
cd arxai
pnpm --filter @workspace/scripts test:shell-header-browser
```

Uses the existing declared Playwright dependency. Requires its Chromium browser
or the system Chromium used by existing browser checks. An explicit
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` may select an installed binary; a missing browser
fails the check rather than skipping it. No credentials or running API are needed.

## Coverage

- Original baseline: 390, 900, 1100 and 1366 CSS pixels, 900px high,
  100% zoom and 1× device scale (16 combinations).
- Short 100% viewports: 1100×480 and 390×480.
- Genuine 200% Chromium tab zoom: 1800×900, 1800×640 and 1100×640
  windows become 900×450, 900×320 and 550×320 CSS-pixel viewports.
- Text-only 200% enlargement: 1100×480 and 390×480. Also combined
  200% tab zoom + 200% text in an 1800×640 window (900×320 effective).
- All 12 scenarios cover page/Cockpit and expanded/compact docks in German LTR:
  **48 combinations**. The baseline additionally covers Arabic and Hebrew RTL
  (32 combinations), preserving the separate direction regression: **80 total**
  plus network, negative-probe and notification-count tests. Enlarged-text/zoom
  results are not claims of combined RTL/enlargement coverage.
- Controlled translated-length titles, long account labels/options, three safety
  notices (including an unbroken reference and mixed Latin/numeric RTL content),
  real notification counts of 0, 1, 9 and 999.
- Document and nested header/notice overflow, ancestor clipping, real Tab focus
  with outline/ring evidence, viewport bounds and unobscured control centers.
- Local account selection; real Tab/Enter activation of inert emergency,
  sign-out/review, layout and tools controls; scrollable tools lists, mobile
  sheets and the real notification bell.
- Direction-aware popover anchoring, inline-start desktop dock, mirrored phone
  header/tray/sheet navigation, badge bounds and attachment, portaled sheet
  direction, cyclic DOM tab order and visible focus in both directions.
- Negative probes prove hidden required controls, clipped Cockpit notices and
  an overlay obscuring keyboard focus are rejected, not silently excluded.
- Exact static-file request allowlist installed before navigation; service
  workers blocked; all WebSockets, external requests, API requests and non-GET
  requests blocked. A separate negative test proves these restrictions.

The fixture renders the production `ARXShellFrame`, shell CSS, global dashboard
stylesheet, Radix sheets, `NotificationBell`, `SafetyHeader` and `EnvironmentPill`.
Only data hooks and the networked alerts drawer are replaced in this isolated
build. Header slot composition mirrors `AppLayout`; account options, notices,
navigation items and callbacks are controlled presentation data, not a mounted
authenticated `AppLayout`. No auth/account providers, role gates, trading gates
or production routes are replaced or exposed.

The fixture build is programmatic, has no production entry import and writes
only to an ignored unique `generated-artifacts/shell-header/run-*` directory.
An ephemeral loopback static server closes when the test finishes; it cannot
proxy requests to the app or a provider. No persistent workflow is added.
Screenshots (including visible keyboard focus), DOM, geometry/focus/network/error
JSON and incremental results are retained there on pass and failure.
Layout popovers and focused tools/mobile sheets have separate screenshots.
Each receipt identifies locale, width, variant and dock mode. The fixture sets
`lang` and `dir` on the document before mounting so body-level portals participate
in RTL; it does not translate or enable localization in the real app.
Build diagnostics are left visible; warnings do not count as assertions.

## Enlargement mechanics and limits

The test-only unpacked extension uses Chromium's `chrome.tabs.setZoom`, then
checks `getZoom`, halved `innerWidth`/`innerHeight`, doubled `devicePixelRatio`
and unchanged `visualViewport.scale`. This is browser page zoom, **not**
CSS `zoom`, a transform, increased deviceScaleFactor, pinch magnification or
viewport reduction alone. The extension is loaded only in temporary browser
profiles for zoom scenarios; it is never part of the fixture bundle or app.
Web-page service workers remain blocked, including in these profiles; the
extension background worker is used only for the tab zoom API.

`?text=200` snapshots original computed font sizes and scales the browser's
font-size CSS declarations from immutable originals, including fixed-pixel CSS
and newly mounted Radix portals. Relative font sizes inherit their scaled parent;
the root rem unit, box dimensions and spacing remain unchanged. It asserts
computed title/notice/menu/sheet fonts equal twice their baselines, and existing
baseline values must remain unchanged after interactions.
This controlled text-only enlargement is distinct from native browser
font-preference coverage and is also exercised together with real tab zoom.

“No document overflow” means no horizontal document/nested text overflow;
desktop Cockpit additionally keeps vertical scrolling inside its main column.
Long page/mobile content may scroll vertically. Scrollable content is not
misclassified as permanently clipped by an outer Cockpit boundary: real Tab
focus must bring each control fully into the viewport with an unobscured center.
Mobile focus scroll margins reserve room for the fixed tray. Visible glyph
overhang from normal line metrics is not treated as hidden text overflow.

Native closed-details contents are excluded using browser visibility checks.
Finite production animations settle before geometry is measured. Viewport-fixed
sheet portals are checked against the viewport rather than the normal-flow body
box. Radix autofocus is blurred only to record the unfocused style baseline;
reachability is established using real Tab presses, never programmatic focus.

This is synthetic regression evidence, **not authenticated workspace acceptance**.
The blocked signed-in screenshots and interaction checks in
`ARX_UNIVERSAL_SHELL_DEVELOPMENT.md` remain blocked and are not reclassified.
