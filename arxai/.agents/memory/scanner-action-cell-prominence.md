---
name: Scanner Action-cell prominence
description: Why the Market Scanner header truth-strip "Action" pill's visual emphasis must stay verdict-invariant (honesty).
---

The Market Scanner header truth-strip (`ScannerHeaderSummary.tsx`, `TruthPill`) has
four cells — Data / Eleanor / Trading / Action. The **Action** cell is the
one-glance decision, so it carries a display-only `prominent` emphasis frame
(`border-primary/40 bg-primary/5 ring-1 ring-primary/15`).

**Rule:** that emphasis frame must be applied REGARDLESS of the verdict, and must
use the neutral `primary` (cyan/blue) accent — NEVER `success` green, and NEVER
scaled up on a positive/READY verdict. The only verdict-correlated signal in the
cell is the verdict text + its tone (`actionTone(actionUi.tone)`), which is the
shared-contract-derived value and stays untouched.

**Why:** the whole Scanner polish task has one core rule — never make a
stale/conditional/weak/non-ready setup look more trade-ready than it is. In this
theme "go" semantics are carried exclusively by success-green / danger-red;
`primary` is the established neutral-informational tone. A static, verdict-
invariant frame cannot encode readiness (it looks identical for NO_CLEAN_SETUP,
FEED_LIMITED, WAIT, and READY_NOW), so it reads as "this is the decision cell,"
not "this decision is affirmative." Making the frame green, or strengthening it
on READY, would falsely signal a "go".

**How to apply:** if you ever restyle the Action cell or add per-verdict styling,
keep the frame neutral and verdict-independent; let the verdict text/tone carry
the meaning. Same principle for any future "highlight the decision" affordance on
the scanner.
