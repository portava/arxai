# ARX AI Dashboard — Design Spec (UI Refresh, "Calm Confidence")

**Status: authoritative.** Appliers follow this verbatim. Where a page conflicts
with this spec, the spec wins — *except* for anything on the Do-Not-Touch list
(§9), which always wins over the spec.

Character: a serious money tool that feels composed. Modern fintech clarity,
not terminal cosplay. Space, surface contrast, and one confident blue do the
work; green/amber/red are reserved strictly for meaning.

---

## 1. Color tokens

All tokens live in `src/index.css` and ONLY there. Raw HSL triplets in
`:root` (light) and `.dark`; `@theme inline` maps them to utilities. Both
palettes are complete — every token exists in both. The app is force-dark
today (AppLayout adds `.dark`); the light palette is what pre-login routes
render and is a first-class citizen. **Do not change the theme mechanism.**

The brand accent is the existing ARX blue — `#2F8CFF` (dark) / a deepened
`#0F6FE0`-family blue (light) of the same hue 213. Do not introduce new hues.

### Dark (primary theme)

| Token | HSL | ≈Hex | Role |
|---|---|---|---|
| `--background` | `219 30% 7%` | `#0D131A` | page ground — deep calm, not black |
| `--foreground` | `216 33% 97%` | `#F5F8FB` | primary text |
| `--card` | `218 28% 11%` | `#141B24` | raised surface |
| `--card-border` | `218 20% 16%` | `#212A34` | quiet card edge |
| `--popover` | `218 28% 10%` | `#121820` | menus, popovers |
| `--popover-border` | `218 20% 18%` | | |
| `--border` | `218 20% 16%` | | generic 1px lines (quieter than before) |
| `--input` | `218 18% 22%` | | form control borders |
| `--primary` | `213 100% 59%` | `#2F8CFF` | THE accent (unchanged brand blue) |
| `--primary-foreground` | `0 0% 100%` | | |
| `--secondary` / `--muted` / `--accent` | `218 24% 15%` | `#1D2530` | flat fills, hovers |
| `--muted-foreground` | `219 15% 68%` | | |
| `--destructive` | `354 100% 65%` | `#FF4D5E` | |
| `--ring` | `213 100% 59%` | | focus |
| `--ruby` | `192 100% 60%` | `#35D7FF` | Ruby/AI cyan (secondary accent, unchanged) |
| `--success` | `156 77% 58%` | `#42E6A4` | P&L up, healthy (unchanged) |
| `--warning` | `43 100% 65%` | `#FFCC4D` | caution (unchanged) |
| `--danger` | `354 100% 65%` | `#FF4D5E` | P&L down, blocked (unchanged) |
| `--premium` | `258 88% 74%` | `#A78BFA` | elite/premium tier |
| `--txt-secondary` | `219 18% 78%` | | readable secondary text |
| `--txt-muted` | `218 12% 62%` | | readable muted text |
| `--sidebar` | `219 32% 6%` | `#0A0F15` | one step below page bg |
| `--sidebar-border` | `218 22% 13%` | | |
| `--sidebar-accent` | `218 24% 14%` | | active/hover nav fill |
| `--shadow-hsl` | `220 60% 2%` | | shadow color base |

`--arx-blue: 213 100% 59%` and `--text-secondary: 219 15% 70%` are kept as
legacy aliases in BOTH palettes (arbitrary-value consumers exist).

### Light (complete — no more missing semantics)

| Token | HSL | Role |
|---|---|---|
| `--background` | `216 33% 98%` | cool near-white |
| `--foreground` | `222 40% 12%` | |
| `--card` | `0 0% 100%` | `--card-border 216 20% 90%` |
| `--popover` | `0 0% 100%` | `--popover-border 216 20% 88%` |
| `--border` | `216 20% 90%` | `--input 216 18% 84%` |
| `--primary` | `213 88% 46%` | same hue as dark, deepened for white bg |
| `--primary-foreground` | `0 0% 100%` | |
| `--secondary`/`--muted`/`--accent` | `216 24% 95%` | |
| `--muted-foreground` | `218 12% 42%` | |
| `--destructive` | `354 72% 48%` | fg `0 0% 100%` |
| `--ring` | `213 88% 46%` | |
| `--ruby` | `192 95% 34%` | |
| `--success` | `156 72% 30%` | |
| `--warning` | `36 90% 36%` | |
| `--danger` | `354 72% 48%` | |
| `--premium` | `258 66% 50%` | |
| `--txt-secondary` | `218 16% 32%` |  `--txt-muted 218 10% 46%` |
| `--sidebar` | `216 30% 97%` | border `216 20% 90%`, accent `216 24% 92%` |
| `--shadow-hsl` | `220 40% 20%` | |

Charts (both palettes): chart-1 = primary blue, chart-2 = ruby cyan,
chart-3 = success green, chart-4 = warning amber, chart-5 = danger red —
at the palette's own lightness.

### Semantic discipline
- `text-success` / `text-warning` / `text-danger` / `text-ruby` /
  `text-premium` (+ their `/10` bg tints and `/25` borders) are for **meaning
  only**: P&L, direction, risk, status, AI attribution. Never decoration.
- Neutral information uses `text-txt-secondary` / `text-txt-muted`.
- **Never** use raw `zinc-*`, `slate-*`, `gray-*`, `emerald-*`, `rose-*`,
  `amber-*`, `red-*`, `cyan-*`, `violet-*` classes in NEW or EDITED lines —
  replace with tokens as you touch a line. (Exception: `scalpLabels.ts`
  FLAME_STAGE_TONE is test-pinned to contain "emerald" — leave it.)
- Status tones come from `STATUS_COLORS` in `src/lib/design-tokens.ts`,
  which is token-based after this refresh. Use its helpers
  (`pnlTone`, `directionTone`, `confidenceTone`, …) — never hand-write
  conditional color classes.

## 2. Type

- Family: **Inter** (now actually loaded via one Google Fonts link in
  `index.html`, weights 400/500/600/700, `display=swap`) with full fallback:
  `"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`.
  Mono: `ui-monospace, "SF Mono", Menlo, Consolas, monospace`.
- Scale (4 steps + micro):
  - Page title: `text-2xl font-bold tracking-tight` (30px on `md:` via TYPO.display where used)
  - Section/card title: `text-base font-semibold tracking-tight`
  - Body: `text-sm`
  - Caption: `text-xs text-muted-foreground`
  - **Micro-label** (metadata only): `text-[11px] font-semibold uppercase tracking-wider text-muted-foreground`
- **Numbers:** `tabular-nums` on every numeric cell. Base CSS applies
  `font-variant-numeric: tabular-nums` to all `<table>` elements and
  `[data-numeric]`; `TableCell` carries `tabular-nums` too. For non-table
  numeric readouts add the `tabular-nums` utility yourself.
- Use `TYPO` composites from `design-tokens.ts` where a page needs them.

## 3. Space

- 8pt rhythm. Card padding: `p-6` (compact contexts `p-4`, never `p-3` for a
  card). Section vertical gap: `space-y-6` (dense: `space-y-4`).
- Page gutters come from AppLayout: `p-4 sm:p-6 lg:p-8`, content capped at
  `max-w-[1600px] mx-auto`. Pages do NOT add their own outer horizontal
  padding. Text-heavy pages may self-cap at `max-w-4xl`.
- Grids of cards: `gap-4` minimum, `gap-6` preferred at `lg:`.

## 4. Radius & elevation

- Radius tokens (index.css): `rounded-sm` 6px · `rounded-md` **8px (controls:
  buttons, inputs, selects, tabs triggers)** · `rounded-lg` 10px ·
  `rounded-xl` **12px (cards, dialogs, popovers)** · pills/badges
  `rounded-full`. No other corner styles.
- Shadows are tokenized (`--shadow-xs … --shadow-2xl`, colored by
  `--shadow-hsl`, so they read correctly in both themes). Recipe:
  - resting card: `shadow-sm`
  - hover/raised (dropdown, popover): `shadow-md`
  - overlay (dialog, command palette): `shadow-lg` / `shadow-xl`
- **Prefer surface contrast over borders.** Cards get `border-card-border`
  (already quiet); do not stack extra inner borders — use spacing and
  `bg-muted/40` wells for sub-grouping.
- `hover-elevate` / `active-elevate-2` utilities are now DEFINED (currentColor
  overlay at 6% / 10%). They are the standard hover treatment on Button and
  Badge — don't add competing `hover:bg-*` on top of them.

## 5. Component recipes (implemented in `src/components/ui/*`)

Variant names, sizes, exports and props are UNCHANGED everywhere — this is a
class-string reskin only.

- **Button** — base: rounded-md, `text-sm font-medium`, ring-2 offset focus,
  `hover-elevate active-elevate-2`. `default`: `bg-primary
  text-primary-foreground shadow-xs`. `destructive`: same shape on
  `bg-destructive`. `outline`: transparent bg, 1px `var(--button-outline)`
  border, `shadow-xs`. `secondary`: `bg-secondary` flat. `ghost`: transparent
  with overlay hover. Sizes untouched (`min-h-9` default). One primary
  (default-variant) button per surface region; everything else outline/ghost.
- **Badge** — pill (`rounded-full`), `px-2.5 py-0.5 text-xs font-medium`.
  Status pills compose `STATUS_COLORS[tone].badge`.
- **Card** — `rounded-xl border border-card-border bg-card shadow-sm`.
  `CardTitle` = `text-base font-semibold tracking-tight`. Header `p-6 pb-4`
  rhythm stays as shipped (`p-6` + content `p-6 pt-0`).
- **Input / Textarea / Select trigger** — `rounded-md border-input
  bg-transparent shadow-xs`, focus = `border-ring` + `ring-2 ring-ring/25`
  (calm, no hard outline jump).
- **Tabs** — list: `rounded-lg bg-muted/60 p-1`; trigger: `rounded-md`,
  active = `bg-background text-foreground shadow-xs`.
- **Table** — head cells are micro-labels (`text-[11px] uppercase
  tracking-wider text-muted-foreground`, `h-10 px-3`); body cells `p-3
  tabular-nums`; rows `border-border/60`, hover `bg-muted/40`. Right-align
  numeric columns at the call site (`text-right`).
- **Dialog** — overlay `bg-black/60 backdrop-blur-sm`; panel `rounded-xl
  border-border bg-popover p-6 shadow-xl`.
- **Tooltip** — `bg-popover text-popover-foreground border border-popover-border
  shadow-md rounded-md text-xs` (no more solid-primary tooltips).
- **Skeleton** — `bg-muted/70 animate-pulse rounded-md`. Loading layouts
  mirror the real layout's shape (same card grid, 2–3 lines per card).
- **Empty state** — use `src/components/ui/EmptyState.tsx`: centered in the
  card, muted icon in a `bg-muted/50` rounded-full well, one-line title
  (what will appear here), one sentence of guidance (how to get it), optional
  single action button. Kind, plain language — never a bare "No data".
- **Status pills** — `StatusBadgeRow` / STATUS_COLORS `.badge` strings:
  `bg-{tone}/10 text-{tone} border-{tone}/25 rounded-full`.

## 6. Page layout rules

- One `<h1>`-weight page title per page; subtitle in `text-sm
  text-muted-foreground` under it. Section headers are card titles or
  micro-labels, not extra bold walls.
- Primary action: exactly one `default` button per surface; secondary actions
  outline/ghost, destructive actions `destructive` and never the visual
  default.
- Progressive disclosure: dense diagnostic detail folds behind
  `CollapsibleSection` (default collapsed); admin/debug readouts never lead a
  page.
- Wide monitors: tables and dashboards live inside the 1600px cap; wide
  tables scroll inside their own container (the `Table` wrapper already does
  `overflow-auto`) — never smear edge to edge.

## 7. Shell

- Sidebar: `bg-sidebar` one step darker than the page; active item =
  `bg-sidebar-accent` fill + `text-primary` icon (as shipped, testids
  unchanged); group labels = micro-label at 35 % opacity.
- Topbar: `h-14 sticky backdrop-blur`, token borders only.
- The compact status row under the Topbar uses `border-border/60
  bg-background/60` (no raw zinc).
- Command palette: overlay `bg-black/50 backdrop-blur-sm`, panel `rounded-xl
  border bg-popover shadow-xl`, active row `bg-accent`. Structure, items,
  testids untouched.
- `/` and `/trade-command-room` hide the global header and own their chrome —
  restyle those in their page pass using the same tokens.

## 8. Charts (for the applier who owns chart surfaces)

Hex constants in `lightweightChartsAdapter.ts`, `ARXNativeChart.tsx`, and the
recharts analytics charts should be re-pointed at the palette equivalents:
up-candle `#42E6A4`, down-candle `#FF4D5E`, overlays `#2F8CFF`/`#35D7FF`,
grid `#212A34`, axis text `#9AA6B5`-family. Read the theme at mount as
TradingViewLiveChart already does. Do not change data or engine logic.

## 9. DO NOT TOUCH

1. **Test-pinned copy** — any user-facing sentence asserted by the vitest
   suites (scanner-truth, coming-soon-affordances, surface-consolidation,
   mission-honest-labelling, approval-inbox-honesty, backtest-route-honesty,
   live-ai-harness, synthetic-feed-copy, news-risk, market-health, honesty
   labels, gate reasons, risk warnings). Reword nothing you haven't verified
   is unpinned.
2. **Token utility names** `text-success`, `bg-success/10`, `ring-success/20`,
   `text-warning`, `text-danger`, `text-txt-muted` — class-asserted by
   `ScannerHeaderSummary.readiness.test.tsx` and
   `GlobalMarketHeatCard.test.tsx`. The tokens keep these names forever.
3. Routes, hrefs, nav group structure/visibility, access tiers
   (`adminOnly`/`approvedOnly`), `COMMAND_PALETTE_ITEMS` contents.
4. All `data-testid` attributes and aria roles/labels.
5. Component public APIs (variant names, props, exports) of `components/ui/*`.
6. Data hooks, query keys, polling intervals, anything under `lib/` that isn't
   a style constant.
7. The force-dark mechanism in `AppLayout` and the localStorage keys
   (`highroll.sidebarCollapsed`, `arx.nav.*`, `theme`).
8. `scalpLabels.ts` FLAME_STAGE_TONE (pinned to contain "emerald").
9. File existence/absence pinned by `surfaceConsolidation.test.ts` — don't
   rename or move page/component files.
10. `pnpm-lock.yaml` — never commit it.
