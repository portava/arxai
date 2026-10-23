---
name: Live trade confirmation UX rule
description: How to gate live-trade dispatch in the UI without leaking operator-style typed phrases or raw safety-gate diagnostics to normal users.
---

# Rule

In any user-facing live-trade ticket / dispatch surface:

1. Do **not** render the server-side confirmation phrase (e.g. `EXECUTE LIVE SHARED`, `ENABLE LIVE TRADING`) as user-visible text or as a label like "type X to enable". The phrase stays a backend constant, attached automatically by the client helper that calls `/execute`.
2. The user-facing gesture is a **single** final Confirm-button click (label "Confirm Buy"/"Confirm Sell"/"Confirm Live Test Cycle"), with a `busy` guard preventing double-submit. There is **no** separate Validate/Review pre-step and **no** acknowledgement checkbox — these were explicitly removed. The Confirm is disabled only on computed input validity and must show the **exact** disabled reason inline; missing SL/TP and Ruby bias-mismatch are surfaced as **non-blocking** inline warnings (SL warning only when SL is actually waived for that profile, so it never contradicts a hard block). All backend gating (16 gates, audit, kill switch) still runs server-side on dispatch regardless of UI. **Why the change:** the dual-action ritual was redundant friction for owner/admin manual live trading; safety is enforced server-side, not by the extra UI step.
3. Raw safety-gate output — engine booleans (`liveExecutionDefaultDeny`, `liveBrokerExecutionEnabled`, `mt5Connected`, etc.), `primaryReason`/`reason` codes, and `blockReasons` arrays of gate identifiers — is forbidden in the normal-user path. Render `humanizeReason(primaryReason ?? reason)` for normal users and put the raw payload inside a `<details>` drawer gated by `mode.shouldShowAdminDiagnostics`.
4. Block/refusal copy uses neutral language ("Trade blocked by safety checks") and never echoes internal gate names.

**Why:** Two CI guards (`risky-wording-frontend`, `no-internal-names-user-ui`) and the project-wide hard constraints #3 and #5 forbid operator phrases and raw diagnostics in user UI. Past leaks exposed the typed phrase and the full gate-code list to any approved user, which both teaches the verification ritual and surfaces internal architecture. Server-side confirmation enforcement is untouched because the phrase is still attached by the client helper.

**How to apply:** Whenever you touch a component that calls a `/me/live/*/execute`-style endpoint, audit the JSX for: (a) the literal confirmation phrase or any "type X" copy, (b) `String(boolean)` renders of resolver/engine fields, (c) `.map`/`<li>` renders of raw reason-code arrays. All three must be either removed or wrapped in `mode.shouldShowAdminDiagnostics`. Keep the import of the phrase constant only if the client helper still needs to send it on the wire.
