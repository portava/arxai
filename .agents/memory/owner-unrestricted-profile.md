---
name: OWNER Unrestricted profile — frontend contract
description: Every trade-entry UI must consume /api/me/live/profile to waive client-side soft caps. Hardcoding 0.1 lot warnings or forcing SL is a bug for OWNER users.
---

Rule: any UI that lets a user submit a trade (demo or live) MUST fetch `/api/me/live/profile` on open and read `isOwnerUnrestricted`. When true, suppress: (a) the soft lot-size warning + its ack checkbox, (b) the stop-loss "required" validation when SL is null. Keep the SL assessor running when SL IS provided — admins still want broker-stop-level warnings.

**Why:** Backend already supports this profile end-to-end (`lib/live/userRiskProfile.ts` resolves it from `user_master_live_access.assigned_risk_template_id` → `risk_templates.name === "Owner Unrestricted Live"`; the live pipeline waives `requireStopLoss`/lot caps for it). When a frontend hardcodes its own caps, the admin gets warnings the server doesn't enforce, blocking review/submit unnecessarily. This was discovered when ScannerTradeModal showed "Lot 0.3 exceeds safe default (0.1)" + forced SL for an OWNER user — backend would have accepted the order.

**How to apply:** Reference implementation is `LiveTradeTicket.tsx` (uses react-query) or `ScannerTradeModal.tsx` (uses raw fetch + useState, matching the file's existing pattern). Pattern: derive `isOwnerUnrestricted = !!profile?.isOwnerUnrestricted`, then `bigLot = lotSize > THRESHOLD && !isOwnerUnrestricted`, and `skipSlAssessor = isOwnerUnrestricted && sl == null`. Show an indigo banner reminding the user that server kill switch / bridge heartbeat / broker validation / final confirmation remain in force. Never expose `isOwnerUnrestricted` to gate live-dispatch decisions — it's UI-only; the 16-gate evaluator is server-authoritative.

**Safety:** The endpoint is `requireUser`-gated and the template name is OWNER-role-gated server-side, so a normal user fetching it can never get `isOwnerUnrestricted: true`. Default-deny on fetch-in-flight (treat unknown as normal user) is the correct safe default — do NOT invert this to suppress warnings during the loading window.
