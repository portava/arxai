# Replit command — R1: apply the prodready branch (fix pack + un-clobber + Round A)

**This is the first and most important apply.** Everything in this delivery was built and verified on a full local clone of the workspace (snapshot `main` @ `8f115c2`, exported 2026-08-19), committed on branch `prodready/20260819`.

## What happened (decision record — read before applying)

Commit `9185c8b` ("Git commit prior to merge", 2026-08-19 15:15 UTC, 189 files) committed a **stale workspace state over the in-flight fix-pack merge**. It deleted 30+ honesty/race QA tests, `liveCommandCas.ts`, `provenance/index.ts`, `allocationBlown.ts`, `contractSize.ts`, `accountCurrency.ts`, the `eventLog` + `discoveryPipeline` schemas, and the source of `lib/discovery`, `lib/validation`, `lib/features`, `lib/risk`, `lib/money`; reverted `forexIntelligence` / `indicesIntelligence` / news-risk to fabricated-data versions; and resurrected zombie surfaces (Build DD `marketData` routes, `systemFullHealth`, `entrySniperRepo`) whose removal those deleted tests pinned.

The branch reverts that clobber file-by-file (`.replit` kept at HEAD to preserve the pepper removal from `8f115c2`), then layers the approved P0 fix pack and Round A repairs on top.

## Branch contents (commit order)

1. `P0 fixpack` — production `SESSION_SECRET` hard-fail; production CORS same-origin lockdown (`ARX_CORS_ALLOWED_ORIGINS` escape hatch); stale-doc corrections (18 gates, 56 guards, 7 strategies, bridge-v2 endpoints live, isolation status).
2. `Revert clobber 9185c8b` — the restore described above.
3. Round A repair commits (see `fixpack/ROUND_A_NOTES.md` in this delivery for the itemized list).

## Apply

The branch arrives either by `git push` from the owner's Mac (preferred) or by dropping the bundle:

```bash
git fetch origin prodready/20260819 || git bundle unbundle /path/to/prodready-20260819.bundle
git checkout prodready/20260819
pnpm install
pnpm run typecheck
pnpm run ci:guards
```

Expected: typecheck clean; **59/59 guards** (3 restored guards: `check-no-fabrication`, `check-live-dispatch-cas`, `check-no-committed-pepper`).

Then run the full `pnpm run ci` on Replit (needs the sanctioned CI database — never the production `DATABASE_URL` from the shell, per standing rule).

## Merge (owner press)

After CI is green: merge `prodready/20260819` → `main`, redeploy. Confirm the deployment secrets contain a real `SESSION_SECRET` — production now refuses to boot without one (that is intentional).

## Post-deploy checks

- Dashboard home: the Trading Setup Readiness card loads (double-mount fixed).
- `/learning` page renders data or an honest empty state (no permanent skeletons).
- FX / Indices Centers show the honest "not connected" state, not moving fabricated numbers.
- MT5 Setup checklist no longer mentions `MT5_BRIDGE_TOKEN`.
- `POST /api/admin/trading/emergency-kill` followed by a live dispatch attempt refuses with `EMERGENCY_KILL_SWITCH_ENGAGED`.
