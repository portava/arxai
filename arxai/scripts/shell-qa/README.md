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

- 390, 900, 1100 and 1366 CSS pixels, 900px high, 100% zoom and 1× device scale.
- Page and Cockpit frames, each with expanded and compact docks: 16 combinations.
- Translated-length title, long account options, three safety notices (including
  an unbroken reference), real notification counts of 0, 1, 9 and 999.
- Document and nested header/notice overflow, ancestor clipping, real Tab focus
  with outline/ring evidence, viewport bounds and unobscured control centers.
- Local account selection, inert emergency/sign-out/review callbacks, layout
  choices, tools sheets, mobile sheets and the real notification bell.
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
Build diagnostics are left visible; warnings do not count as assertions.

Native closed-details contents are excluded using browser visibility checks.
Finite production animations settle before geometry is measured. Viewport-fixed
sheet portals are checked against the viewport rather than the normal-flow body
box. Radix autofocus is blurred only to record the unfocused style baseline;
reachability is established using real Tab presses, never programmatic focus.

This is synthetic regression evidence, **not authenticated workspace acceptance**.
The blocked signed-in screenshots and interaction checks in
`ARX_UNIVERSAL_SHELL_DEVELOPMENT.md` remain blocked and are not reclassified.
