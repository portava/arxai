# Replit command — R8: Master Blueprint integration (Parts II–V)

**Source:** `ARX_AI_Master_Architecture_Intelligence_and_Research_Blueprint.docx` (owner, 2026-08-19). A text extraction ships in this delivery as `blueprint-extracted.md` — drop it into the Replit workspace so Claude Code can read it (Part I duplicates the Function Encyclopedia; the new material is Parts II–V, from the heading "Part II — Complete ARX improvement program").

**Owner directive:** "build on top of current system, extend to what's there."

## How the blueprint maps onto the running program (executive integration ruling)

The blueprint's **Part V twelve-phase sequence becomes the program's master sequence**. The R-series docs remain the concrete work orders; each now slots into a blueprint phase. Nothing already delivered conflicts with it — the sequence mostly *ratifies* the order we chose:

| Blueprint phase | Status / owning work order |
|---|---|
| **0 — Constitution & repo truth** | Largely EXISTS (59 CI guards, safety contracts, one repo, R1 restore). New: Owner Decision Registry (II-54), policy-as-code consolidation, Capital Constitution (II-53). |
| **1 — Read-only broker truth** | **R6** (multi-broker Phase 0/1) verbatim. |
| **2 — Evidence foundation** | **R2** (execution_events, UNKNOWN) + restored eventLog/feature chain + R7-step-2 shadow durability. New: Bitemporal Economic Ledger (II-29), Double-Entry Capital Accounting (II-30), Time-Travel Debugger (II-35). |
| **3 — Research & first validated edge** | **R7** steps 4–6 on the restored discovery/validation packages, governed by **Part IV's lifecycle + minimum evidence package** (adopt verbatim as the research SOP). Negative-Knowledge Library (II-12) added to the registry schema. |
| **4 — Common decision & risk path** | **R3** (risk-kernel gaps) + Opportunity Lifecycle/Dedup/Conflict/Admission (II-17…21). |
| **5 — Demo execution truth** | **R2** epistemology + **R5** Deriv demo + adapter certification. Independent Protection Watchdog (II-28) joins here. |
| **6 — Self-Trading guided mode** | Largely EXISTS (scanner, native chart, Ruby, instant-trade funnel, Round A menu honesty). New: Bounded Autonomy Levels (II-37), Personal Trading Constitution (II-38), Approval Inbox with expiring tickets (II-43), Manual Takeover (II-44). |
| **7 — Shadow & controlled demo automation** | **R7** + Champion-Challenger (II-15), OOD detection (II-3), structural breaks (II-9), continuous certification (II-56). |
| **8 — Limited live** | The current controlled owner-only live testing posture already matches this phase's shape (one owner account, one broker, canary capital, 23 gates + kill-switch pre-gate). Blueprint adds: expiring authority and recovery probation (II-34) — build these. |
| **9 — Portfolio & multi-broker intelligence** | R6 later phases + Capital Scheduler, Portfolio Intelligence, Risk-of-Ruin simulator, Market Selection (II-20…24). |
| **10 — Managed Allocation** | R6 workspace/compliance slices + Risk Cells, ownership resolver, separation of duties (II-47…52). |
| **11 — Advanced autonomous research** | Part II 13–16 & 53–61 + the Part III research backlog (explicitly non-commitments — keep as backlog). |

**Central rule adopted program-wide** (blueprint Part II): *more intelligence never automatically earns more authority* — every capability ships with an evidence requirement, an authority boundary, and a removability path. Part V's "Immediate decisions and holds" are all already honored by the current system or the R-series (real-money default-off, EA channel, broker-native data, self-trading first, netting prohibition, COMPLIANCE_HOLD, no quotas).

## Instruction for Claude Code in the Replit shell (after R1 is merged)

---

Read `blueprint-extracted.md` Parts II–V. Then implement the **Phase 0 completion slice** on branch `feat/blueprint-phase0`:

1. **Owner Decision Registry** (II-54): a small append-only `owner_decisions` table + admin read UI section + a markdown mirror in `docs/OWNER_DECISIONS.md`. Seed it with the standing rulings already scattered through this program: TypeScript-not-Python; integer-FK identity; compose-don't-duplicate; netting demo/shadow-only; emergency-close kill-switch exemption; fail-closed defaults; the Part V holds. Every future irreversible ruling gets a row.
2. **Capital Constitution** (II-53): encode the currently-true authority hierarchy (deterministic risk > AI > strategy > execution; owner presses every authority increase) as a checked-in constitution doc + a CI guard that greps its inviolables the way `check-no-fabrication` works.
3. **Architecture fitness functions** (II-57): audit which of the blueprint's boundary rules the existing 59 guards already enforce; add only the missing ones (no duplicates — extend `scripts/src/ci/`).
4. **Research SOP** (Part IV): commit the research lifecycle + minimum evidence package verbatim as `docs/RESEARCH_OPERATING_SYSTEM.md`, referenced by the restored `lib/discovery` pre-registration flow.

Then STOP and report. Phases 1–5 proceed through the existing R2–R6 docs; when each R-doc's work lands, tag which blueprint phase it advances in the commit message so the Owner Decision Registry and the phase table stay truthful.

---

**Hold points:** the registry schema (owner presses the migration), and any capability from Part II that would raise autonomy (Bounded Autonomy Levels beyond current behavior, challenger promotion, capital scheduling) — those are owner-enablement moments by the blueprint's own central rule.
