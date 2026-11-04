# ARX universal shell — development report

## Source and scope

- Branch: `codex/pr103-smart-chart-development-20261031`
- Final validated application commit: `e0f61c0e1a6e222f0144096e7bba99ef767bd23c`
- Starting recovery checkpoint: `466abc7c16c478ca10ba7e2464d52f9ce793b03c`
- Main shell implementation checkpoint: `252e4ab98a7135bab9965303083bb44e8b9a5775`
- Frontend-only changes under `arxai/artifacts/trading-dashboard`. No backend, database, broker, order, risk-policy or authentication implementation changes.

## What changed

- `AppLayout` now mounts the cyan Command Workspace shell on all signed-in routes, including Trade Command Room. The old sidebar, top bar, mobile navigation and footer are no longer mounted there. Legacy component exports remain for compatibility; they are not the active app shell.
- Shared dock, header, searchable All tools sheet, Layout menu and mobile tool tray. Specialist routes use existing catalog destinations and active-route highlighting; Cockpit keeps panel-focus destinations and Analyze/Trade/Review controls.
- Existing role-filtered navigation remains the source of truth. Approved/admin restrictions remain; investors receive only their existing portal/account/settings/help destinations. Emergency Stop is exposed directly to roles permitted to access that route, not added to investor navigation.
- Non-Cockpit routes retain the existing live-mode, notification-center and safety components in the shell notices strip. Skip link, route guard, Ctrl/Cmd-K palette, Ruby assistant and floating actions remain mounted.
- Browser preferences support compact/expanded dock, fit/wide content and comfortable/compact density. The old sidebar-collapse preference is migrated once. Panel preferences are user- and route-scoped; existing Cockpit preferences are read through the migration path.
- Reusable pin/collapse panels now wrap the top-level Market Scanner, Open Trades, Risk and Alerts page content. This does not rewrite their nested cards or data hooks.
- Cockpit account providers remain behind the route guard. Its header controls render through a React portal, preserving their original provider context rather than mounting account providers outside authorization.
- Responsive shell styles include wrapping header actions, min-width constraints, phone tool tray and sheets. Actual signed-in viewport geometry is not accepted without the browser checks below.

## Actual validation

| Check | Result |
| --- | --- |
| Full frontend Vitest run | **3,456 passed, 11 skipped, 0 failed; exit 0** |
| Test files | 227 passed, 1 skipped (228 total) |
| Frontend TypeScript | Passed |
| Frontend production build | Passed |
| Initial JavaScript budget, unchanged limits | Passed: 688,386 raw bytes / 200,107 gzip bytes; limits 720,000 / 210,000 |
| Whitespace/diff validation | Passed |
| Development frontend HTTP | 200 |
| Browser safety preflight | 1 passed: request restrictions installed before navigation |
| Requested authenticated browser UI checks | 0 passed, 0 established app failures, **7 blocked groups** |

The initial focused test attempt recorded 54 passed / 2 failed. The failures were incorrect new test expectations: frame test IDs and the expectation that the legacy browser-wide sidebar preference should leak to a second user. Those assertions were corrected to match the intended component IDs and user isolation. The successful full run includes both corrected tests.

The build retains a large-chunk warning. Vitest emitted a jsdom “navigation to another Document” diagnostic but exited successfully; it was not suppressed.

## Browser evidence and limitations

The test browser had no authenticated ARX session. Root navigation redirected to the normal login screen. No credentials, invitations, account creation, auth bypass, password reset or permission changes were used.

Blocked: desktop and mobile screenshots of Cockpit, Market Scanner and Risk (six route/viewport combinations), plus the authenticated shell interaction group covering search, keyboard access, preferences across navigation/reload, panel pin/collapse, presets, active navigation and Emergency Stop visibility. Therefore no claim is made that those signed-in viewport checks passed or that phone horizontal overflow was measured.

Tester screenshot `f0o4q9` records the settled desktop login screen; `ko7y9p` is its earlier loading state. A separate 1366×768 preview capture likewise showed the normal sign-in screen, not the requested workspace. These are authentication-blocker evidence, not completed workspace screenshots.

Development workflow logs also contain earlier `Object is disposed` chart errors during the refactor's hot reloads, without a useful stack. Their cause and behavior after a clean authenticated reload are unverified. Do not describe them as fixed or infer that the full test pass proves otherwise.

## Runtime and remaining work

- Existing Vite frontend and API workflows remain running. Frontend changes are served through Vite hot reload; the development root responds HTTP 200.
- No workflow restart, API rebuild/replacement, database migration/schema push, post-merge database hook, trading action, broker test, email, GitHub push, deployment or publication was performed.
- No other source-editing job was observed at completion; the design helper and browser tester had finished. This is not a claim about every external task or user session.
- Signed-in visual/interaction acceptance and the six requested screenshots remain blocked. Review a clean authenticated preview before publication, including chart disposal behavior and all target desktop/phone widths.
- Existing provider, first-navigation and chart-performance limitations are not resolved or reclassified by this shell change.

## Desktop desk fill, account-strip and header follow-up — 2026-11-04

Validated application: `91cd579a9a796f19f5ec4408ac26409fc2792758`.
Baseline: `8671e4f75f828f9894d9ff6a85efe39ca7ea085e`, including the merged
shared-header fixtures and specialist-panel persistence improvements.

### Corrections

- Desktop widths from 1024px explicitly retain three equal-height column tracks.
  Legacy right-column spanning/two-column rules are reset within that scope.
- The last expanded panel fills spare space in the left/right columns; the
  centre favours the price chart. If every panel in a column is collapsed, its
  last card fills the track without reopening content or changing saved state.
  Pinning uses the panel's actual normalized expanded state. Panel order,
  presets, persistence and mobile focus logic were not changed.
- The shared header now keeps its natural height instead of shrinking against a
  content area requesting the full viewport height. Main content takes the
  remaining flex space, so the account strip begins below the complete header.
- Header positioning is sticky with an opaque ink background and its own
  stacking context; portalled presets/refresh/system controls remain within it.
- No backend, authentication, permission, risk, trading, broker or data-hook
  implementation changes.

### Final results on this source

| Check | Actual result |
| --- | --- |
| Focused workspace/frame/account-strip tests | 13 passed, 0 failed |
| Full frontend suite | **3,465 passed, 11 skipped, 0 failed; exit 0** |
| Full test files | 229 passed, 1 skipped |
| Frontend typecheck | Passed |
| Production frontend build | Passed; existing large-chunk warning retained |
| Unchanged initial-JS budget | Passed: 688,479 bytes raw / 200,135 gzip; limits remain 720,000 / 210,000 |
| Diff whitespace | Passed |
| Development root HTTP | 200 |
| Isolated desktop geometry regression | 1 passed, 0 failed, 0 skipped |

New jsdom coverage checks normalized pin/collapse state and that all five account
labels belong to main content after, rather than inside, the header. jsdom does
not establish physical clipping; the separate Chromium check uses the shipped
CSS with clearly synthetic layout content and blocks network requests:

```sh
cd arxai
node --test scripts/shell-qa/desk-fill.geometry.test.mjs
```

That check passed all **768 collapse combinations** (256 each at 1100×900,
1500×900 and 1900×900), column-top alignment, column-bottom fill within 1.5px,
account-label containment and a normalized pinned-clock fill check at each
width. Actual measured header-bottom/account-strip-top pairs were
65.84375/81.84375px at 1100px and 48/64px at both wider widths. A 900×500 scroll
case kept the sticky header at y=0 and its controls within y=33.84375–61.84375,
inside the 65.84375px header.

These are geometry-fixture results, not authenticated chart/data acceptance or
performance evidence. The fresh 1500×900 app-preview capture redirected to the
normal login page (401 identity response). No sign-in bypass or credential
operation was attempted. Signed-in visual acceptance remains unverified.

The only non-failing frontend-test diagnostic was jsdom's existing
“navigation to another Document” message; no errors or tests were suppressed.
No failed final check was discarded.

### Concurrent work and boundaries

Larger-text shell checks were still in progress, and right-to-left shell work
was reported implemented/awaiting merge. Those later changes are not covered by
the exact-source counts above; neither was overwritten or imported by this
follow-up. Only the listed application changes and this report were saved.

No API/frontend workflow restart, database change/migration/schema hook,
publication/deployment, GitHub push, broker action, order or trading-policy
change was performed. The running frontend receives these changes through Vite.
All previously reported signed-in, provider and navigation limitations remain
open unless separately verified.

## Usable plot and expanded-content follow-up — 2026-11-04

Validated application: `58dcba733c376497e704ffb27e2186963e0e5617`.
Baseline: `f94c7bcbe2c5c0175c1055c68b6d75972c5e5612`, preserving the merged RTL
shell work as well as the earlier column-fill and account-strip corrections.

### What changed

- Desktop content may scroll vertically rather than compressing expanded panels.
  Their bodies retain intrinsic content height, without the earlier body-height
  caps. The existing last-expanded-panel fill rule remains.
- The compact desktop chart reserves a 390px canvas, leaving approximately
  360px for the price plot after the time axis. Older 180/240px desktop
  reductions are removed. Spare centre-column height grows the chart, with a
  scoped observer resizing the existing engine to the rendered container.
  Observer/listener cleanup ignores delayed callbacks after unmount.
- Single-chart layout wrappers pass spare height through to that same chart.
  No chart/calculation engine was duplicated. Mobile sizing/focus logic and
  fullscreen sizing remain separate.
- Risk labels and amounts use two columns of stacked, wrapping text rather than
  four competing inline cells. Budget calculation and permission logic are
  unchanged.

### Actual verification

| Check | Final result |
| --- | --- |
| Full frontend suite | **3,468 passed, 11 skipped, 0 failed; exit 0** |
| Test files | 229 passed, 1 skipped |
| Chart lifecycle focused suite | 98 passed, 0 failed |
| Typecheck | Passed |
| Production frontend build | Passed; existing large-chunk warning retained |
| Unchanged initial-JS budget | Passed: 688,479 raw bytes / 200,158 gzip bytes; limits remain 720,000 / 210,000 |
| Previous column-fill geometry regression | Passed: 768 collapse combinations, plus strip/header checks |
| Actual Cockpit offline production fixture | **12/12 viewport/preset cases passed**, 0 skipped |
| Development root HTTP | 200 |

The actual-Cockpit fixture imports the application and existing data hooks,
intercepts API responses with synthetic inputs and blocks writes and external
traffic. It is not the deployed build or a signed-in user's account. The default
synthetic instrument was EURUSD; authenticated V25_1S/provider acceptance is not
claimed. This is layout evidence, not trading, freshness or performance evidence.

| Viewport | Preset | Price plot px | Canvas px | Main client/scroll height px |
| --- | --- | ---: | ---: | ---: |
| 1366×768 | All expanded | 362 | 390 | 690 / 962 |
| 1366×768 | Analyze | 362 | 390 | 690 / 939 |
| 1366×768 | Trade | 362 | 390 | 690 / 902 |
| 1366×768 | Review | 362 | 390 | 690 / 962 |
| 1440×900 | All expanded | 362 | 390 | 822 / 960 |
| 1440×900 | Analyze | 362 | 390 | 822 / 937 |
| 1440×900 | Trade | 362 | 390 | 822 / 900 |
| 1440×900 | Review | 362 | 390 | 822 / 960 |
| 1920×1080 | All expanded | 404 | 432.5 | 1002 / 1002 |
| 1920×1080 | Analyze | 426 | 455 | 1002 / 1002 |
| 1920×1080 | Trade | 464 | 492 | 1002 / 1002 |
| 1920×1080 | Review | 404 | 432.5 | 1002 / 1002 |

Every case checked the actual price plot, expanded-body scroll/clipping geometry,
Review order containment when expanded, clock time containment, nonoverlapping
risk cells, equal column bottoms and absence of document horizontal overflow.
No Review order or execution action was clicked. There were no browser page
errors; the two recorded POST attempts (activity ping and chart AI-alert scan)
were blocked with fixture 503 responses, not sent to the app API.

Run the new acceptance check with:

```sh
cd arxai
node --test scripts/scanner-qa/desktop-content-fit.test.mjs
```

This replaces the earlier no-scroll acceptance policy for this request. The
older `compact-workspace-geometry.test.mjs` script's strict all-tools-in-viewport
expectations were not rerun or claimed as passing.

### Retained failures, limitations and concurrent work

- Initial focused attempt: 99 passed / 5 failed because the new observer path
  was absent from jsdom. The component now explicitly supports a resize-event
  fallback where ResizeObserver is unavailable. Height assertions were updated
  from the obsolete 180/240px desktop behavior, not skipped.
- Browser attempt 1: an overly broad test selector opened chart details and then
  timed out; 12 matrix cases were unstarted. Attempt 2: dynamic nth locators
  changed as panels opened and timed out; 12 cases were unstarted. The selector
  now snapshots stable panel test IDs. Both failed attempt logs are retained.
- First full frontend attempt: 3,467 passed / 1 failed / 11 skipped. The new
  lifecycle test referenced its mock engine without defining the local variable.
  After correction, the 98-test focused suite and full suite passed. No test or
  unhandled error was suppressed.
- Receipts are retained locally under ignored
  `generated-artifacts/arx-desktop-content-fit-20261104/`: browser-attempt1.log,
  browser-attempt2.log, browser-final.log, frontend-attempt1.log,
  frontend-final.log and build.log. Fixture build ID: `ab3d94078f34ec19`.
- A fresh 1440×900 native capture still reached normal login. No authenticated
  screenshot or real-account/provider result is claimed. Previous navigation,
  provider and signed-in limitations remain open.
- Short-landscape shell work was reported implemented concurrently but had not
  merged into this validated source. No concurrent changes were overwritten.

No API restart, backend/data-hook change, database operation, permission/risk
policy change, order, broker call, publication/deployment or GitHub push occurred.
The frontend workflow remains running and receives source through Vite.

## Saved side-rail follow-up — 2026-11-04

Application commit: `938b900f6438a336fa3932d500fbfbfdb64a06e4`.
Recovery baseline: `16b1f77d39eb9e0a33ca6cef38b28885599ca107`.

### Interaction and persistence

- Both desktop side columns can collapse to 50px rails. Each panel has a labeled
  icon; activating it **expands that side and focuses the selected panel**.
  The implementation consistently uses expand/focus, not flyouts.
- Individual panel headers can move their unpinned panel to the rail. The last
  visible panel moving to the rail collapses the whole side. Partly railed
  columns retain icons for the hidden panels and fill their remaining height.
- Pin protection applies to individual controls, whole-side requests, presets
  and restored storage. Pinned panels never disappear into the rail.
- The existing per-user/per-route browser record gains an optional `railed`
  list; existing layouts and legacy migration remain compatible. It is not an
  account setting or a backend preference.
- The shared Layout menu includes Left tools and Right tools Shown/Rail choices.
  Analyze rails unpinned right tools; Trade shows both sides; Review rails
  unpinned left tools. Existing vertical-collapse preset behavior is retained.
- Order entry's rail includes a separate one-click **Review order** action that
  opens the existing reviewed-order sheet. This does not execute an order.
  Emergency Stop and safety notices remain outside the collapsible columns.
- Desktop rails apply at 1024px and above. Mobile focus, bottom tray, ordinary
  chart controls and tablet presentation are unchanged.
- `SidePanelArea` is shared, and `RouteLayoutPanel` accepts a side-area option
  with the same saved behavior. The current specialist routes use full-width
  top-level sections rather than dedicated shared-panel side columns; those
  sections were not arbitrarily narrowed or moved. Reuse on a specialist side
  panel is covered by the focused component test.

### Verification on the combined application

- Focused shell/model/panel checks: **23 passed**, including seven new rail
  cases for collapse/expand, draft and focus preservation, partial rails,
  pins, user/route isolation, reload/remount, Layout controls, mobile mode,
  specialist side reuse and preset/storage sanitization.
- Existing Scanner comparison/source regression: **10 passed** in isolation.
- Final serial full frontend run: **3,475 passed / 11 skipped / 0 failed,
  exit 0**; 230 test files passed and one was skipped. The existing jsdom
  navigation-not-implemented warning remained non-fatal.
- Typecheck and production frontend build passed. Existing large-chunk warning
  remains; no warning threshold was raised.
- Initial JavaScript budget passed: **692,690 raw / 201,302 gzip bytes** against
  unchanged limits of 720,000 / 210,000.
- Existing fill/header/account-strip check: **768 combinations passed**.
- Actual Cockpit offline production fixture: **12/12 size/preset cases passed**
  at 1366×768, 1440×900 and 1920×1080, plus rail interactions and a 390px phone
  check. Price plots stayed at least 362px on the two smaller desktop sizes.
- At 1440×900 the chart's actual container width changed **541 → 777 → 1049px**
  for shown sides → left rail → both rails. Both rail widths measured exactly
  50px. The chart engine's plot geometry resized with the container; no browser
  page errors, including disposed-chart errors, were recorded.
- The browser exercised rail icons, focus, pinning Order entry, one-click
  reviewed-order opening, reload persistence and Enter-key expansion. Emergency
  Stop remained visible. Desktop rail controls were absent on the phone layout
  and there was no phone horizontal document overflow.

The browser used clearly synthetic EURUSD history, actual application
components, intercepted API responses and blocked all writes/external traffic.
No authenticated owner/V25_1S/provider acceptance, first-navigation speedup or
production readiness is inferred.

### Retained attempts and evidence

- Initial focused run: 22 passed / 1 failed, with one unhandled error because
  jsdom lacks `scrollIntoView`. The test now supplies that DOM-method stub;
  focus assertions remain intact. Production code does not suppress errors.
- Initial typecheck found an Element-versus-HTMLElement query type; the query
  is now explicitly typed and the final check passes.
- Browser attempt 1 completed four size/preset cases, then timed out attempting
  an expand control inside a previously railed side. Eight matrix cases and
  the subsequent rail journey were unstarted. The All-expanded case now first
  expands each side using its actual rail control.
- Browser attempt 2 completed all twelve matrix cases and the resize/review
  sequence, then failed reload persistence because the offline harness cleared
  local storage on every reload. Its existing explicit preservation option is
  now enabled. The subsequent complete run passed.
- A pre-refinement run passed the initial width-growth assertions but gave the
  chart only 9px from left collapse because the opposite column also grew.
  Grid sizing now preserves the opposite column's share; stronger assertions
  require at least 100px growth per side at the measured viewport. The final
  run passed with the widths above.
- The first full suite had **3,474 passed / 1 failed / 11 skipped**: the existing
  Scanner comparison test exceeded its unchanged 5-second timeout while a
  concurrent build was running. Its isolated rerun passed without source,
  timeout or assertion changes. This observation alone does not prove the
  cause of the timeout.
- Local receipts and synthetic screenshots are under ignored
  `generated-artifacts/arx-side-rails/`: `browser-attempt1.log`,
  `browser-attempt2.log`, `browser-before-width-refinement.log`,
  `browser-final.log`, `frontend-attempt1.log`, `frontend-final.log`,
  `scanner-intervals.log`, `build.log`,
  `both-rails-desktop.png` and `mobile-focus.png`. Final fixture build:
  `b6be0937ec9d9f21`.

No backend, trading/risk policy, account, permission or data-hook changes were
made. No API restart, database operation, broker call, executed order,
publication/deployment or GitHub push occurred. Independent enlarged-text and
short-landscape QA merges were waiting on the workspace lock and were not
part of this measured application.

## Chart ceiling, bounded rationale and left-fill follow-up — 2026-11-04

Application: `ca350e26b14b29b02a3e2ddf29ccf45dfd90b375`.
Recovery baseline: `495da744ffc84e24eb70aeb6e73105022116e827`.

### Correction

The compact plot previously grew with its flex column and passed the resulting
height back into the chart engine. That created a feedback path between the
engine's intrinsic canvas height and the flex layout, especially when sibling
content grew.

The plot now uses fixed viewport-derived height rather than unbounded flex
growth. Its normal target is 60% of viewport height, limited by 65% and the
available main-content height after the account strip. A 390px canvas reserves
roughly 360px of price plot where there is sufficient space; unusually short
windows respect the upper bound rather than overflowing it. Initial engine
creation is capped too, including restored oversized height inputs.

The existing observer watches the container, main content and account strip,
and responds to window resize. It never sends an unbounded observed height to
the engine. The listener/observer still retire on cleanup, including late
callbacks. Opening evidence or settings cannot enlarge the fixed plot beyond
its ceiling.

The AI read's full rationale is a labeled, keyboard-focusable region with
maximum 320px height, native vertical scrolling and wrapping of long words,
code and paragraphs. This changes presentation only, not the read, Truth gate
or trading authority.

The existing last-expanded-panel fill rule is retained. Left-column geometry
is checked against the final visible panel, including rationale-open cases;
side rails still release horizontal space to the chart.

### Actual desktop results

| Viewport | Canvas px | Price plot px | Rationale closed/open | Gap below last left panel |
| --- | ---: | ---: | --- | ---: |
| 1366×768 | 460 | 432 | Both passed | 0px |
| 1440×900 | 540 | 512 | Both passed | 0px |
| 1920×1080 | 648 | 620 | Both passed | 0px |

All six closed/open cases passed. Open rationale areas measured 320px high,
with thousands of pixels of deliberately long synthetic text scrollable
inside; scroll widths equalled client widths (272/291/332px), not overflowing
their panel. Risk followed the AI panel normally and the expanded order body
retained at least 72px. These checks do not claim that every panel can remain
inside one short viewport when all details are open; the desk remains scrollable.

The actual application fixture also passed twelve existing size/preset cases,
evidence/settings open-close bounds, rail resize/reload/pin/keyboard checks and
the phone overflow check. The chart still widened 541 → 777 → 1049px with side
collapse. No browser page errors were recorded.

The long AI read was provided by a specific intercepted endpoint response:
clearly synthetic, non-actionable, with no claimed provider evidence. The
ordinary application Truth gate remained in place; no bypass was installed.
All external calls and mutations remained blocked. This is not an
authenticated owner/provider/V25_1S acceptance result.

### Validation and limitations

- Focused chart lifecycle and AI read tests: **107 passed**, no failures.
  Coverage includes a 1,500px observed height clamped back to its viewport
  target, oversized initial height and ignored callbacks after unmount.
- Typecheck: passed.
- Serial full frontend suite: **3,476 passed / 11 skipped / 0 failed, exit 0**;
  230 test files passed and one was skipped.
- Production frontend build: passed, retaining the existing large-chunk warning.
- Unchanged initial-JS budget: passed, **692,690 raw / 201,298 gzip bytes**
  against 720,000 / 210,000 limits.
- Prior column-fill/header/account-strip geometry: **768 combinations passed**.
- Development root HTTP: 200. The agent's native browser remains signed out;
  its login rendering is not an authenticated desk acceptance claim.
- This round had no failed focused or browser attempts. The existing jsdom
  navigation warning and previously recorded failures remain documented.
- Final offline fixture build: `d28e8c605fe0e2fb`.
- Evidence is retained under ignored `generated-artifacts/arx-desk-bounds/`.
  Native signed-in acceptance remains for the owner; no credentials were
  requested or account state changed.

No backend/data-hook, risk-policy, permission, authentication, database or
operational setting changes; no API restart, worker/trading activation, broker
test, order, email, publishing/deployment or GitHub push. Pending independent
shell QA merges were not included in this application.

## Isolated long-content browser regression (2026-11-04)

Added a standalone fixture in `arxai/scripts/shell-qa/`. Run from the workspace
root with:

```sh
cd arxai
pnpm --filter @workspace/scripts test:shell-header-browser
```

The fixture renders the real shared frame, dashboard/shell styles, Radix sheets,
notification bell and safety/environment components. Hook data, header account
options, multiple notices and action callbacks are controlled. It does **not**
mount an authenticated AppLayout, identity/account providers or trading services.
AppLayout, authorization rules, trading gates and account-provider placement
remain unchanged.

Coverage: page and Cockpit variants, expanded and compact docks at **390, 900,
1100 and 1366px**, each 900px high at **100% zoom**. All 16 combinations check
long translated-length titles/account labels, three notices including an
unbroken reference, nested/document overflow, ancestor clipping, real Tab focus,
unobscured control centers, layout choices, tools/mobile sheets and inert safety
actions. Notification counts additionally cover 0, 1, 9 and 999 with the actual
badge and accessible label.

Only exact local static GETs are allowed. External/API/mutating traffic and
WebSockets are blocked before navigation, service workers are disabled, and an
independent negative test verifies the restrictions. The ephemeral static server
has no backend proxy. No credentials, auth bypass, database changes, broker
actions, emails or live commands are involved.

The checks exposed and now protect against three presentation issues:

- A wrapping phone header could place Sign out behind the wider Layout summary.
  Layout and actions now have separate full-width grid rows on phones.
- A wrapped layout summary could position its menu outside the frame; the menu
  is now anchored to the bounded header and stacked above the sticky safety
  component so its controls remain reachable.
- Mobile sheet navigation lost the shell-scoped focus color across its portal.
  Shell color variables now apply to sheet roots as well.

Historical validation (100%-zoom baseline):

| Check | Result |
| --- | --- |
| Browser matrix + isolation + count subtests | **18 passed** (Node reports 19 including the parent), exit 0 |
| Existing shell/frame/preferences/navigation unit checks | **31 passed**, 4 files, exit 0 |
| Frontend TypeScript, incremental output disabled | Passed, exit 0 |
| Whitespace validation | Passed |
| Frontend managed workflow | Restarted successfully; Vite ready |
| Shared-preview smoke check | Passed after starting the existing safe-preview API workflow |

Historical browser receipts: `generated-artifacts/shell-header/run-jpXrjg/`.
The ignored directory retains screenshots, keyboard-focus screenshots, DOM,
geometry/focus/network/error JSON and incremental per-case results, including
failure evidence in earlier unique run directories. The latest command log is
listed in the enlargement section below. Earlier baseline attempts include fixture
resolution/visibility/focus-baseline/animation measurement errors and an
interrupted timeout run; they are not additional accepted coverage. The fixture
build still prints a sheet sourcemap-location diagnostic and large-chunk warning;
neither was suppressed or counted as a failed assertion.

**The blocked authenticated screenshots and interactions above remain blocked.**
Synthetic fixtures extend regression protection; they do not establish actual
signed-in Cockpit/Scanner/Risk geometry, provider behavior or execution safety.
The separate normal preview capture still showed sign-in, not workspace
acceptance; its API request initially returned 502 with the API workflow not
started. The first completion attempt passed code review but failed
`bash scripts/check-arx-preview.sh` on `/api/healthz` for that reason. Starting
the existing managed API workflow via its unchanged safe-preview launcher
restored the check: `/`, `/login`, `/src/main.tsx` and `/api/healthz` all passed.
Startup confirmed background jobs paused, the live master switch disabled and
no schema migration performed. The fixture itself still neither starts nor
depends on that API. No unrelated runtime issues were resolved or reclassified.

## Enlarged-text and short-height synthetic regression

The standalone shell fixture now retains the original 16 baseline combinations
and adds 32 enlargement/height combinations: both frame variants and both dock
modes in every scenario below. These results are separate from the historical
100%-zoom run above.

| Scenario | Browser window | Effective CSS viewport | Tab zoom | Text size |
| --- | --- | --- | --- | --- |
| Baseline (four widths) | 390/900/1100/1366 × 900 | Same | 100% | 100% |
| Short desktop / phone | 1100×480 / 390×480 | Same | 100% | 100% |
| Zoomed desktop | 1800×900 | 900×450 | 200% | 100% |
| Zoomed short desktop | 1800×640 | 900×320 | 200% | 100% |
| Zoomed mobile reflow | 1100×640 | 550×320 | 200% | 100% |
| Enlarged text desktop / phone | 1100×480 / 390×480 | Same | 100% | 200% |
| Combined zoom and text | 1800×640 | 900×320 | 200% | 200% |

Real Chromium tab zoom is set using a test-only extension's
`chrome.tabs.setZoom` and verified with `getZoom`, effective viewport dimensions,
device pixel density and unchanged pinch scale. No CSS zoom, transform,
deviceScaleFactor shortcut or viewport-only simulation is used.
Controlled text-only enlargement doubles the actual computed font sizes,
including fixed-pixel production type and subsequently mounted sheet portals;
assertions compare each title/notice/menu/sheet font against its baseline.
It is not evidence for other browsers' native font-preference settings.

Every case checks the long title, account labels, all three notices, required
emergency/review/sign-out controls, layout menu and tools sheets. Real Tab/Enter
presses activate safety actions and open/operate the layout and tools controls.
The all-tools fixture contains nine inert entries to force scrolling at short
heights. Focus must have a visible indicator, fit fully inside the viewport and
have an unobscured hit-test center. Layout labels may wrap rather than overflow.
Negative probes deliberately hide Sign out, clip Cockpit content and obscure
keyboard focus; all three must be rejected by the corresponding assertions.

The checks exposed presentation-only issues corrected in shared shell CSS:
Cockpit's header/notices no longer flex-shrink into overlapping controls, and its
main column scrolls internally when enlarged content exceeds the available
height. Layout choices permit wrapping and mobile controls reserve scroll margin
above the fixed tray. No chart behavior, role or trading gate was changed.
There must be no horizontal document or nested text overflow; desktop Cockpit
must also avoid vertical **document** overflow. Normal page/mobile vertical
scrolling and accessible internal scrollports are expected, not failures.

The exact static-only GET allowlist, blocked API/mutation/external/WebSocket
traffic and independent containment test remain intact. Web-page service workers
are blocked even in the temporary zoom browser profiles; only the extension's
background worker supplies the browser zoom API. No auth/account provider,
authorization gate, trading gate or production route is bypassed or exposed.
The fixture never contacts the normal API, database, market-data or broker.

**Authenticated acceptance remains blocked.** The ordinary preview capture
still showed sign-in, not a workspace; it initially logged an API 502 because
the API workflow was stopped. The existing safe-preview API launcher was started
unchanged for the shared-router check, independently of this static fixture.
Neither the synthetic matrix nor the preview sign-in screenshot establishes
signed-in Cockpit/Scanner/Risk geometry or live-execution safety.

Evidence includes scenario/zoom metrics, immutable text-baseline comparisons,
stage, every Tab attempt (also on failure), hit-test/viewport/scroll receipts,
screenshots, DOM, blocked traffic and browser errors. Failure screenshots use
the viewport instead of a full-page capture if overflow exceeds 6000px, so an
overflow defect cannot exhaust Chromium while saving its evidence.
Earlier unique runs and focused continuations are retained as failed or partial
diagnostics, not extra accepted matrix coverage. In particular, a discarded
computed-font override could compound text after interactions and exhaust the
renderer. The final text-only fixture instead scales immutable original CSS
font declarations; existing baseline receipts must not drift after interactions.

Final enlargement validation before integration with the RTL regression:

| Check | Result |
| --- | --- |
| Full 48-case matrix + containment + negative probes + badge counts | **51 subtests passed** (52 including parent), 0 failures/skips, exit 0 |
| Existing frame/preferences/catalog/navigation unit checks | **31 passed**, 4 files, exit 0 |
| Frontend TypeScript, incremental output disabled | Passed, exit 0 |
| JavaScript syntax and whitespace checks | Passed |
| Managed frontend workflow | Restarted after the CSS batch; Vite ready |
| Safe-preview API workflow | Running unchanged; background jobs paused, live master switch disabled, no schema migration |

Accepted enlargement receipts: `generated-artifacts/shell-header/run-Iik7zR/`.
The full command log is `generated-artifacts/shell-header-final.log`; unit and
type-check logs are `generated-artifacts/shell-unit-check.log` and
`generated-artifacts/shell-types-check.log`. Earlier failed full runs and focused
diagnostics remain in other unique run directories and their separate logs.
The pre-existing sheet sourcemap-location diagnostic and large-chunk warning
remain visible in the build output and are not counted as passing assertions.

### Integration with the separate RTL regression

The shared runner now preserves both suites without multiplying unrelated
coverage: all 48 German LTR height/enlargement cases plus 32 Arabic/Hebrew RTL
baseline cases, for 80 configured cases (and three auxiliary subtests). Direction
assertions, cyclic DOM Tab-order checks, translated account labels and separate
layout/tools/mobile focus screenshots are retained. Direction assertions run
on the original baseline scenarios; combined RTL plus enlargement is not claimed.
The 48-case receipt above predates this integration and is not presented as an
80-case run. Two attempted merge-only name filters selected no browser cases;
their file-load-only results are not accepted browser coverage.

Merge verification selected 32 cases: 24 baseline combinations at 390/1100px
across all three locales passed, but eight enlarged-phone/combined cases exposed
the incoming sticky header trapping controls below a short viewport. The header
now remains sticky at normal heights and becomes normal-flow at heights up to
600 CSS pixels. The unaffected 900px-high baseline checks are unchanged.

The focused correction run passed **all eight affected cases plus the three
auxiliary subtests** (12 including the parent), exit 0, with no failed or skipped
executed tests. Corrected receipts: `generated-artifacts/shell-header/run-VNJLv6/`;
log: `generated-artifacts/shell-header-merge-fixed.log`. The earlier selected run,
including its 24 passing baseline cases and eight failures, remains at
`generated-artifacts/shell-header/run-Xsl4RJ/` with log
`generated-artifacts/shell-header-merge-selected.log`. These complementary checks
are not represented as a single passing full 80-case run. The managed frontend
was restarted after the correction and came up cleanly.

## Isolated right-to-left regression coverage

The same static-only browser fixture now sets document-level `dir`/`lang` before
mounting for controlled Arabic and Hebrew copy, retaining the German LTR
baseline. Each locale covers page/Cockpit, expanded/compact docks and all four
existing widths (390/900/1100/1366): **48 unique cases, 32 RTL and 16 LTR**.
Long titles, account labels/options and safety notices include mixed Latin
symbols/numbers and unbroken references. This is not a production localization
feature and does not mount authentication or account services.

Additional assertions cover logical popover anchoring, inline-start dock
placement, mirrored phone header/tray/sheet items, portaled sheet direction,
badge viewport/clipping/overlap bounds and attachment to its bell, and forward
cyclic DOM tab order with visible, unobscured focus. Layout, tools-focus and
mobile-sheet-focus screenshots complement the per-case DOM/JSON receipts.

The initial run (`generated-artifacts/shell-header/run-2uOGL1/`, command log
`generated-artifacts/shell-rtl-initial.log`) passed all 16 LTR cases and failed
all 32 RTL cases specifically on physical popover anchoring. The only production
change replaces desktop `right` and phone `left` anchors with their logical
inline equivalents. Other physical positioning in the stylesheet was inspected
but left unchanged without failure evidence; the explicitly right-sided tools
sheet and symmetric fixed tray are not indiscriminately mirrored.

Final browser validation: **48 matrix cases plus containment and notification
count checks passed** (50 subtests; Node reports 51 including the parent), exit 0.
Receipts: `generated-artifacts/shell-header/run-nXL0Kb/`; command log:
`generated-artifacts/shell-rtl-final.log`. All normal cases recorded zero
blocked-request attempts and zero runtime errors. The existing sheet sourcemap
diagnostic and large-chunk warning remain visible, not suppressed. Shell frame,
layout-model and catalog unit tests passed (8 tests across 3 files).
The managed frontend workflow restarted cleanly with Vite ready.

**Authenticated workspace screenshots and interactions remain blocked.** The
normal preview capture at `generated-artifacts/shell-rtl-preview.jpg` shows the
sign-in page, not an authenticated shell. Its initial API 502 occurred before
starting the existing safe-preview API workflow; startup then confirmed paused
background jobs, disabled live master switch and no schema migration. The
isolated tests neither depend on nor call that API.

## 2026-11-04 — Shared sliding panels, peeks and docking

- Recovery checkpoint: `1c2da4619bba31362b46929bd7d249c7da7e03ad`.
- Tested application/source commit: `2c97673cd4c00064a13c19dcd37378a99d12ecb5`.
- Branch: `codex/pr103-smart-chart-development-20261031`.
- The final documentation checkpoint is returned in the completion response.

### Changes

Desktop close controls now send panels fully into their edge rail. The nine
Cockpit panels and existing Smart Chart secondary details support icon-to-peek,
outside-click/Escape dismissal, Keep open docking and protected pins. Positions
use the bottom rail. Panels remain mounted to preserve drafts and running views;
closed panels release their layout space. Both center panels can be closed
without making their peeks unreachable. Chart details retain their existing
React providers while docking into the tools area.

The shared route-panel wrapper supplies the same behavior on existing specialist
sections. State is scoped to the existing user/page browser preferences, including
peek restoration. Presets set the open panels, excluding protected pins. Legacy
fold/rail preferences are retained; the newly separate chart-details panel starts
closed unless pinned. Mobile keeps its existing focus behavior.

Slides are 200ms; reduced motion disables both the animation and the delayed exit.
Keyboard focus returns to rail icons, peeks contain Tab focus, and existing
command-palette/fullscreen/alert dialogs retain ownership of their own Escape key.
Emergency Stop, safety notices and the existing reviewed-order action remain
available; no order, permission or financial logic was changed.

### Final validation

| Check | Actual result |
| --- | --- |
| Full frontend suite | **3,480 passed, 0 failed, 11 skipped; exit 0** |
| Test files | 230 passed, 0 failed, 1 skipped |
| Frontend TypeScript | Passed |
| Production frontend build | Passed; chunk-size advisory remains |
| Unchanged initial-download budget | **696,986 raw / 202,765 gzip bytes**, below 720,000 / 210,000 |
| Actual production-app offline browser test | **1 passed, 0 failed, 0 skipped** |
| Fixture builder syntax / Git whitespace check | Passed |

The browser run served a frozen production frontend on loopback with synthetic
inputs. All API writes and external/model/provider/broker traffic were blocked.
It exercised 12 desktop size/preset combinations (1366×768, 1440×900, 1920×1080;
All/Analyze/Trade/Review), six rationale-open/closed cases, and close/peek/dock for
all ten desk/chart-detail panels. It also checked both center panels closed,
outside dismissal, nested command-palette Escape, saved peek after reload,
reduced motion, protected pins, one-click reviewed-order access and keyboard
expansion. Market Scanner and Open Trades each passed close/peek/dock and reload
persistence. The 390×844 mobile case retained focus mode without horizontal
overflow or desktop rails.

Measured chart widths in the side-rail case were 541px initially, 777px with the
left rail and 1,049px with both rails. No page/disposed-chart errors were recorded.
These are layout/interaction observations, not navigation or streaming-speed
acceptance. The successful fixture build ID was `73d85decea2fb3a6`.

### Retained failures and adaptations

The first focused run was 16 pass/7 fail; the next was 28 pass/1 fail. The
remaining reload failure exposed a saved-state initialization flash, which was
fixed. A subsequent focused run passed 29/29; the added nested-modal case was
then covered by the successful full suite.

The first full run was **3,475 pass/5 fail/11 skip**: legacy specialist tests still
expected Collapse/Expand and immediate unmounting. They now assert Close/Open,
retained-but-hidden content after the exit, saved rail state and pinning through
a peek. No affected test was skipped or unhandled error suppressed.

An extended browser attempt stopped at `/my-trades` because the isolated static
server did not serve that SPA route. Cockpit cases and the Market Scanner journey
had completed. Only the fixture's existing-route whitelist was extended; unknown
paths stay 404 and API paths stay rejected. The corrected complete browser run
passed. No application routing or security policy was relaxed. Full frontend,
typecheck, build and budget results remain valid: the subsequent correction was
only to offline test serving.

Receipts and screenshots are retained in the ignored workspace directory
`generated-artifacts/arx-sliding-panels/`:

- `frontend-final.log`, `typecheck.log`, `build.log`, `budget.log`, `browser-final.log`
- `initial-full-failures.log`, `initial-focused-failures.log`,
  `second-focused-failure.log`, `first-browser-pass.log`
- `failed-static-route.log`, `failed-static-route.png`
- `peek-order.png`, `peek-chart-details.png`, `both-rails-desktop.png`,
  `mobile-focus.png`, `terminal-attempt.png`

### Scope and remaining limits

Only frontend/presentation, browser preferences and offline QA tooling changed.
No backend, data hooks, trading/risk/permission policy, credentials, database,
worker settings or broker connection changed. No API restart, migration, email,
trade, publication or GitHub push was performed. Existing automatic activity,
alert-scan and focus POST attempts were denied by the fixture; they were not
sent to a real API.

The native preview capture reached the normal sign-in screen (expected anonymous
401), not an authenticated owner workspace. Signed-in owner/provider acceptance,
all specialist-page visual combinations, streaming-burst soak, earlier navigation
and zoom performance gaps remain unverified/open. Synthetic layout checks do not
establish launch readiness or competitor parity. No unrelated concurrent edits
were observed in this application's working tree during the implementation.

## Short landscape shell regression — 2026-11-04

The isolated header browser matrix now includes 667×375, 767×320, 900×400 and
1366×480 alongside the original four 900px-high viewports. Page/Cockpit,
expanded/compact dock, German LTR, Arabic RTL and Hebrew RTL remain covered:
96 distinct combinations, including 48 short-height combinations.

Short-height fixture cases add three layout-choice groups, thirteen inert tools
and an end-of-content button. Checks require viewport-fitting positioned
overlays and real Tab navigation with visible focus, full control bounds and
unobscured centers. Normal-flow notices and menus may scroll. Both portaled
sheet types remain covered; tools-body scrolling is exercised by keyboard.
Each receipt records height and scroll offsets as well as the existing
direction, geometry, focus, network and runtime-error evidence.

The initial run `generated-artifacts/shell-header/run-SGavAS/` demonstrated:
- A sticky phone header covering the focused safety-review button.
- The fixed phone tray covering that button in some RTL cases.
- Desktop Cockpit clipping long notices or the end-of-content control.
- An expanded-dock layout menu extending below a 900×400 viewport.

That diagnostic run was deliberately stopped after 56 matrix cases; it is not
a completed acceptance run. Its failures, screenshots and partial results are
retained, with the command log at `generated-artifacts/shell-landscape-first.log`.

Evidence-backed changes are limited to heights of 500 CSS pixels or less:
the header stops sticking, Cockpit permits natural document scrolling, layout
choices use bounded normal flow rather than an off-screen absolute popover,
and control scroll margins leave room above the fixed tray. Taller layouts,
authentication, providers and trading behavior are unchanged.

The static-file allowlist, negative containment test, service-worker block and
WebSocket/API/external/mutation rejection remain intact. No API or credentials
are needed by the fixture.

Final validation: **all 96 matrix cases plus containment and notification-count
checks passed**, exit 0 (98 subtests; Node reports 99 including the parent).
Receipts: `generated-artifacts/shell-header/run-m4iTjY/`; command log:
`generated-artifacts/shell-landscape-final.log`. All 96 normal cases recorded
zero blocked-request attempts and zero runtime errors. The existing sheet
sourcemap diagnostic and large-chunk build warning remain visible. Screenshots
include keyboard focus in the scrollable tools list and both portal types.

**Authenticated workspace screenshots and interactions remain blocked.**
The short-height preview screenshot still shows the normal sign-in page, not
an authenticated shell; its identity request returned 502 with the API workflow
not running. The frontend workflow restarted cleanly and Vite reported ready.
No claim is made that the signed-in shell or live services were verified.
The first required shared-preview smoke check likewise failed on
`/api/healthz` with 502. Starting the existing safe-preview API workflow then
confirmed API readiness, a reachable database, disabled live master switch,
paused background jobs and no schema migration. This service-startup repair
does not change the authenticated acceptance blocker or the isolated results.

### Combined enlargement and landscape regression after integration

The shared fixture now retains both suites: 16 scenarios yield 128 distinct
page/Cockpit, dock and locale combinations. Baseline and landscape scenarios
cover all three locales (96 cases); the eight additional short/zoom/text
scenarios preserve their German LTR coverage (32 cases). Genuine tab zoom,
text-only enlargement, required-content and negative-probe assertions,
keyboard activation and the static-only traffic boundary are retained.

The header remains non-sticky through 600px height for enlarged screens.
At 500px or less, the landscape rules permit document scrolling and put layout
choices in normal flow. Above 500px, the existing desktop Cockpit internal-scroll
check remains in force. Both sets of inert long tools remain in the fixture.

Combined validation passed with exit 0: **128 matrix cases and all three
containment/negative-probe/notification subtests** (132 reported tests including
the parent). Receipts: `generated-artifacts/shell-header/run-SiZVjb/`;
log: `generated-artifacts/shell-merged-landscape.log`. All normal cases recorded
zero blocked-request attempts and zero browser runtime errors.
This does not remove the authenticated acceptance blocker above.

