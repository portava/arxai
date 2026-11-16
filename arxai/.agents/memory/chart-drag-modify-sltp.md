---
name: Chart drag-to-modify SL/TP (Scanner)
description: How drag-to-modify SL/TP lines is wired on the Scanner chart and the honesty/no-bypass invariants that must hold.
---

# Chart drag-to-modify SL/TP (ScannerChartPanel)

Approved live traders drag SL/TP price lines for their OWN open LIVE positions on
the Scanner chart. Implemented on `ScannerChartPanel.tsx` only (not ARXNativeChart
— that adapter lacks exposed coordinate hooks; pure helpers in
`lib/chart-drag-modify.ts` are reusable if it's added later).

## Single execution path (no bypass)
Every drag submits through `executeInstantTrade({ source: "chart_drag", action:
"MODIFY_SL_TP" })` → the SAME instant-trade router → live pipeline → 18-gate
MODIFY dispatch as a manual trade. NO second path, NO gate/pipeline change. The
new audit source is `chart_drag` (added to FE `InstantTradeSource` +
backend `INSTANT_TRADE_SOURCES`). The chart no-bypass CI guard
(`check-chart-trade-no-direct-execution.ts`) now scans the FE panel too: requires
`executeInstantTrade` + `source:"chart_drag"`, forbids legacy close / broker
command-queue / order-send strings (comment-stripped).

## Entry line is never draggable
**Why:** entry is a fact of the open position, not an editable level. The entry
handle renders `pointer-events-none` with `onPointerDown={undefined}`; only `sl`/`tp`
legs set the drag key. A regression here would let a user "move" their fill.

## Honesty gate must re-check at SEND time, not only on drop
**Rule:** `submitModify()` itself re-checks `isLiveDisplayRef.current` before
reaching `executeInstantTrade`, in addition to the `handleModifyDrop` check.
**Why:** the drop-handler gate alone is insufficient — with one-click OFF the user
drags (feed live), the confirm panel appears, the feed can go unconfirmed/frozen,
then a later Confirm click would send on a dead feed. Caught by architect review.
**How to apply:** any new submit entry point (drop, confirm button, future
keyboard) must funnel through `submitModify`, which is the single honesty
chokepoint. Don't add a parallel send that skips it.

## Ref-freshness for once-mounted pointer listeners
The pointerup listener is mounted once; it calls `dropHandlerRef.current` and the
drop/submit logic reads `posModifyRef` / `oneClickArmedRef` / `isLiveDisplayRef`
(all kept fresh via a no-dep effect) to avoid stale closures. Mirror this if you
add another window-level drag listener.

## Tests
Source-scan render-proof (`ScannerChartPanel.drag-modify.test.ts`) — the panel is
~2.7k lines and imports lightweight-charts (can't render headlessly), so it pins
the contract structurally (same constraint as the sibling refresh-affordance test).
When the send-time gate is added/moved, the `submitBlock()` slice window in that
test must be wide enough to still contain `executeInstantTrade` + `if (res.ok)`.
