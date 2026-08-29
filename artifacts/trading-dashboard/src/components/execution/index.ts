// Build F — Live Execution Safety Layer. Public component surface.
//
// ── STATUS: NOT MOUNTED. Do not count this as a delivered safety layer. ──
//
// Nothing in the app imports from "@/components/execution". PreTradeChecklistModal
// is therefore never rendered, so the checklist it shows (verdict + blockers +
// warnings, Confirm hard-disabled while BLOCKED) never runs for any user, and
// none of ConfirmExecutionButton / CancelTradeButton / ExecutionWarningPanel /
// LiveExecutionHistory is on screen anywhere.
//
// What that means in practice, stated plainly so no one re-derives it wrongly:
//
//  • The modal is the only client that creates an `execution_confirmations`
//    row and moves it to CONFIRMED. routes/trades.ts:200-207 hard-requires a
//    confirmationId for any LIVE POST /api/execute-trade. With the modal
//    unmounted, that branch is unreachable from the UI — which is a
//    default-deny, not a hole, and it MUST stay that way: removing the
//    confirmationId requirement to "clean up the dead branch" would open live
//    /execute-trade with no checklist at all.
//
//  • Live execution that users can actually reach does NOT go through this
//    layer. It goes through the Phase B live command pipeline
//    (LiveTradeTicket / LiveSharedTradeTicket → /api/trades/live-shared/* or
//    /api/me/one-click/submit-live → liveCommandPipeline.ts), which runs the
//    server-side dispatch evaluator on every press. That path is single-confirm
//    by owner decision and is pinned by scripts/src/liveSingleConfirmTest.ts,
//    so this modal cannot simply be bolted onto it as a pre-step.
//
//  • ConvertToLiveExecutionButton (components/tradePlan) used to tell the user to
//    "Open the Pre-Trade Confirmation flow to review and confirm" after creating
//    a PENDING confirmation — an instruction with no destination. That sentence
//    is CORRECTED: the button (and TradePlanBuilderPanel) now say a PENDING
//    confirmation was recorded, that there is no in-app screen to confirm it
//    yet, and that no order has been placed. executionLayerMounted.test.ts pins
//    both halves — the removal of the old sentence AND this paragraph agreeing
//    with it. (A previous pass of this note described that correction as
//    outstanding in the very commit that made it. A file whose whole job is to
//    state the truth is the last place that may go stale, hence the new guard.)
//
//    What remains genuinely open is the other half: these components still have
//    no route or mount point, so a user cannot advance a PENDING confirmation to
//    CONFIRMED anywhere in the app. That is why the STATUS line above still
//    reads NOT MOUNTED.
//
// The guard for this comment is executionLayerMounted.test.ts in this folder:
// it fails if an importer appears (the note above is then stale and must be
// rewritten to describe where it is mounted) and equally if the files are
// deleted while the note still claims they exist.
export { PreTradeChecklistModal } from "./PreTradeChecklistModal";
export type { PreTradeIntent } from "./PreTradeChecklistModal";
export { ConfirmExecutionButton } from "./ConfirmExecutionButton";
export { CancelTradeButton } from "./CancelTradeButton";
export { ExecutionWarningPanel } from "./ExecutionWarningPanel";
export { LiveExecutionHistory } from "./LiveExecutionHistory";
