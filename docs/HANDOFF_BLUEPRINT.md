# ARX AI — handoff blueprint

Written 2026-08-30 by the outgoing assistant. Read this before touching anything.
It is deliberately blunt about what is done, what is a lie the codebase used to
tell, what is still unproven, and what I got wrong.

---

## 1. Where the code is

| Thing | Value |
|---|---|
| Repo | `github.com/portava/arxai` |
| **Deploy source** | the **Replit workspace files**, NOT GitHub. Work flows Replit → GitHub. |
| **The live line** | branch **`phase6/guided-mode`** — NOT `main`. `main` is stale at `d108107`. |
| Live line HEAD | `746e764` (matches the Replit workspace) |
| **Ready and unmerged** | **`build/integration-7`** @ `298c8a9` — 19 commits ahead of the live line |
| Owner's Mac clone | `~/arxai`; worktrees under `~/arxai-wt`, `-wt2` … `-wt7` |

**Everything is pushed.** 52 branches, all synced with origin. The only local-only
branch is `build/unblock-holds`, a scratch staging branch with no unique work.

### The one paste that advances the workspace

```bash
cd ~/workspace && git fetch origin build/integration-7 && git merge --ff-only origin/build/integration-7 && pnpm install && { git diff --quiet pnpm-lock.yaml || git commit -m "chore: lockfile" pnpm-lock.yaml; } && for f in docs/migrations-pending/*.sql; do echo "== $f"; psql "$DATABASE_URL" -f "$f" || break; done && git push origin phase6/guided-mode && echo DONE
```

All 14 pending SQL files are `IF NOT EXISTS`; the 13 already applied re-run harmlessly.
**Do not add `pkill -f vite` to pastes** — it kills the owner's Preview, which
cost real trust. Only stop `tsx watch` if memory genuinely demands it.

---

## 2. What was built (five campaigns, one day)

All adversarially verified — every builder was followed by an independent agent
that re-ran the tests and tried to refute the claims.

- **Fixpack (10 themes)** — fabrication removal, chart truth, invite hardening.
- **Campaigns 1–4** — the full Blueprint Part-II capability set (61/61), the
  Master Build Plan critical path, the gate wall **18 → 23**, the learning
  flywheel (shadow-only), D2 byte-equality, InstrumentPassport, and a complete
  **UI makeover** (design system + long-tail sweep).
- **App audit + fix (92 defects)** — see §4; this is the important one.
- **Holds campaign** — every owner hold taken to the edge of the press.

Capability tree artifact: https://claude.ai/code/artifact/f057246e-94cf-4ece-8f66-37286c632558

---

## 3. THE OWNER'S PRESSES (do not cross these)

You may build up to them. You may not perform them.

1. **`REGISTRATION_KEY_PEPPER` secret** — ⚠️ **ROTATION IS DESTRUCTIVE.** Proven
   from the code: the stored hash is `sha256(normalizeArxKey(raw) + pepper)`,
   one-way, and the raw key is returned once at mint and never stored
   (`invite_code` is null for ARX keys). **Every unredeemed key becomes
   permanently unverifiable and there is no re-hash path.** Run
   `pnpm --filter @workspace/scripts run preflight:registration-key-pepper`
   FIRST (only exists after integration-7 lands). The press also requires a
   **redeploy** — a published build holds a boot-time env snapshot.
2. **Republish** — the deployed app still serves a pre-campaign bundle. None of
   the above is in front of users until the owner republishes.
3. **C8 equity-index data** — two decisions: which instrument (spec pre-registers
   ES; notes allow an equivalent index ETF) and whether the source licence is
   acceptable (`stockanalysis` is undocumented; every series is stamped
   `termsOfUse UNVERIFIED`). Then a **one-shot** evaluation: a MISS retires the
   experiment and charges FDR. Runbook: `docs/C8_DATA_FEED_RUNBOOK.md`.
4. **Capacity estimates** — gate #23 refuses every driver-placed live entry until
   an edge has one. Proposals are generated; the USD ceiling is never proposed.
5. **Conformal + execution-policy flags** — both reports read
   `INSUFFICIENT_HISTORY` at sample 0, and **neither feed has a production
   writer**, so the sample cannot grow on its own. No press is due.
6. **Watchdog host** — three topologies documented with an honest "does NOT
   protect against" for each.

---

## 4. What the app actually is right now

An 8-auditor sweep found **92 defects (14 critical)**. The verdict was: *"a
platform that looks finished and is confidently wrong about the two things that
matter most: their money and their safety."* All 92 are fixed and on the live
line, but read that sentence before trusting any surface you have not traced.

The three worst, now fixed, as a flavour of what this codebase does:
- The emergency kill switch wrote a flag **the live pipeline never read**.
- Live-Trades "Close" was a mock returning `(mock)` in a message the card never
  rendered — the row vanished and the broker position kept running.
- Nine routers had no user scoping: one user's onboarding, P&L and skill scores
  were everyone's.

**The governing rule of this repo:** a surface may never claim, imply, or display
more than the code delivers. Never fabricate a fill, price, or P&L. A failed read
degrades to an honest typed null with a reason — never a confident zero. AUTO
authority may only REDUCE. When something cannot be made real, the accepted fix
is an honest limited surface, not a prettier lie.

---

## 5. Known-true facts you would otherwise rediscover painfully

- **There is NO market data feed.** Zero heartbeats, zero live positions,
  `arx_candles` does not exist. This is why the scanner was slow and the chart
  blank — not a bug. Connect MT5 (bridge is built + certified) or Deriv.
- **Deriv can never trade real money** in this build — owner Ruling 19 denies the
  live tiers; `tierPermitsRealMoney()` returns false unconditionally.
- **Unattended live ENTRIES now refuse** — gates #20/#23 bind driver-placed
  orders and no edge is promoted. That is the spine working, journaled with
  `AUTONOMOUS_ENTRY_REFUSAL_NOTE`.
- **Live dispatch fails closed if `safety_core` is unreadable** —
  `ensureSafetyCoreInitialized()` must have run.
- **Realised profit is still short by broker-side stop-loss closes.** The gap is
  now *labelled* (counts + target lock held) but the NUMBER is incomplete: no
  shipped EA sends `closed:[...]`. The receiving path is built and tested — it
  closes with an **EA change**, not more server code. Do not "fix" this by
  deriving P&L from the stop level; that is the exact fabrication the spine bans.
- **`drizzle-kit push` is BROKEN** (pre-existing `broker_hub` constraint drift).
  Apply schema via raw psql from `docs/migrations-pending/`. Never run push.
- **The DB is DEV**, auto-provisioned by Replit. Not production.
- **Paper/demo now fill** (simulated, from real quotes, tagged, structurally
  barred from economic postings). This changed recently — older comments may lie.

---

## 6. Working practices that cost me something to learn

- **Never blind-union a merge conflict.** Union is safe ONLY for
  import/export barrels and the CI-chain list. I unioned code twice and produced
  duplicated function bodies, a dangling JSX opener and a dropped closing brace —
  two full resets. Read the hunks and resolve by intent.
- **My root-`package.json` resolver only merges the `ci` chain** and keeps "ours"
  for everything else, so it silently dropped two root scripts. Fix it to do the
  same object-union the sub-package path does before the next integration.
- **Re-check `origin/phase6/guided-mode`'s ACTUAL tip before branching** an
  integration. I branched from a stale point and broke the owner's fast-forward.
- **On the owner's Mac**, `pnpm-workspace.yaml` strips non-Linux binaries. Dev
  server and vitest need hand-injected darwin binaries for `rollup`,
  `lightningcss` and `@tailwindcss/oxide` (`npm pack` them, copy into
  `node_modules/.pnpm/...`). Never commit that.
- **`vite.config.ts` requires `PORT` and `BASE_PATH`** or it refuses to load.
- **Replit CI needs a memory sweep first** or it dies silently mid-run (looks
  like a pass: 0 failures but the log ends mid-lane). Check the tail shows a
  FINISHED lane, not a bare header.
- **DB-backed suites cannot run on the Mac** (no Postgres, and the sandbox blocks
  `listen(2)`). They must run on Replit via `ci:integration`. Several are still
  **unrun anywhere** — treat them as unproven.

---

## 7. What I would do next, in order

1. **Land integration-7** (the paste in §1). It carries the pepper preflight, the
   router deadlines, capacity + governance admin surfaces, the watchdog package,
   and the C8 harness. Nothing else is reachable until this lands.
2. **Get a feed connected.** Almost every remaining symptom traces to its
   absence, and C8 aside, nothing about this system can be judged without it.
3. **Run the DB-backed suites on Replit** and believe them over any claim in a
   report, including mine.
4. **Then** the owner's presses, in the order of §3.

Do not start a sixth build campaign. The spec is built. What is left is
evidence, deployment, and the owner's judgement.
