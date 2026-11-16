# ARX production-readiness delivery — 2026-08-19

Built in-house against your `arxai.zip` export (`main` @ `8f115c2`) under the executive-decision grant. Everything verified locally where verifiable; DB-backed lanes and deploys are yours to press.

## The one thing to read first

**A merge accident this morning (commit `9185c8b`, "Git commit prior to merge", 15:15 UTC) silently reverted your fix-pack work** — it deleted 30+ honesty/race QA tests, live-pipeline safety modules (CAS, provenance, allocation-blown, contract-size), the research-package sources, and restored fabricated-data intelligence backends, while resurrecting zombie surfaces whose removal your tests had pinned. Commit 2 on the delivered branch reverts it surgically. Several "critical" findings from the audits were symptoms of this single event.

## Contents

| Path | What |
|---|---|
| `prodready-20260819.bundle` | Git bundle of branch `prodready/20260819` (3 commits). Fetch/unbundle on Replit or push from this Mac. |
| `patches/` | Same 3 commits as `git am`-able patches (review-friendly). |
| `fixpack/` | `ROUND_A_NOTES.md` (itemized changes + follow-ups), `fixpack.diff`, drop-in files for commit 1. |
| `audit-reports/` | The 13 deep audit reports (execution, risk, market-data, Deriv, connections, workspaces, broken-code ×3, menus ×2, intelligence ×2) — file:line-grounded, with dependency-ordered build slices and red-fail tests. |
| `replit-commands/` | The R-series command docs, in order: **R1** apply this branch → **R2** execution epistemology (UNKNOWN state) → **R3** risk-kernel gaps → **R4** market-data provenance → **R5** Deriv Phase 2 demo → **R6** multi-broker Phase 0/1 → **R7** intelligence upgrade → **R8** Master Blueprint integration (adopts the blueprint's 12-phase sequence as the program's master sequence and maps every R-doc into it). Each has hold points for your one-press moments. |
| `blueprint-extracted.md` | Text extraction of your Master Blueprint docx (drop into Replit alongside R8 — Claude Code there can't read .docx directly). |

## Apply order

1. **R1** — get the branch onto Replit, run full `pnpm run ci` (sanctioned CI DB), merge, redeploy. Set `SESSION_SECRET` in deployment secrets first — production now refuses to boot without it (intentional).
2. R2–R4 close the live-trading epistemology/risk/provenance holes — these are the real remaining production-readiness gaps.
3. R5–R6 implement your multi-broker document (TypeScript ruling documented in R6).
4. R7 is the intelligence upgrade: connect the restored validation machinery to real data; WAIT becomes the default; edges promote only through evidence.

## Verification state (local, this Mac)

- Full workspace typecheck: clean (all 14 packages).
- CI guards: **59/59** (3 guards restored by the un-clobber).
- New/restored QA suites run green: emergency-kill-switch gate 7/7, coaching-no-fabricated-exit 10/10, navAccessTier 23/23, backtest-route-honesty 8/8, coming-soon-affordances 9/9.
- Not run locally (needs DB): `pnpm run ci` integration lanes, fundbook suites, DB race tests. Run on Replit before merge.

## Judgments made on your behalf (reversible, say the word)

- TypeScript, not Python, for the multi-broker spec (its own reuse-first rule decides this).
- Legacy `mt5-webhook` deleted rather than patched (server-wide token contract violation + arbitrary-trade-close bug).
- Simulator surfaces (Positions/Manual Ticket/News Risk/Autopilot/Market Replay) hidden from non-admin traders rather than rebuilt per-user in Round A — rebuild candidates live in the menus reports.
- Emergency-kill pre-gate fails CLOSED on unreadable settings, with the admin emergency-close exemption pinned to the existing bypass predicate.
