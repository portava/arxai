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

Final validation:

| Check | Result |
| --- | --- |
| Browser matrix + isolation + count subtests | **18 passed** (Node reports 19 including the parent), exit 0 |
| Existing shell/frame/preferences/navigation unit checks | **31 passed**, 4 files, exit 0 |
| Frontend TypeScript, incremental output disabled | Passed, exit 0 |
| Whitespace validation | Passed |
| Frontend managed workflow | Restarted successfully; Vite ready |
| Shared-preview smoke check | Passed after starting the existing safe-preview API workflow |

Final browser receipts: `generated-artifacts/shell-header/run-jpXrjg/`.
The ignored directory retains screenshots, keyboard-focus screenshots, DOM,
geometry/focus/network/error JSON and incremental per-case results, including
failure evidence in earlier unique run directories. The final command log is
`generated-artifacts/shell-header-final.log`. Earlier attempts include fixture
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

