---
name: "Slow preview" = check workflows are listening first
description: Diagnose a "whole app is ~7s slow / frozen shell" OR "app won't start" report by verifying the api-server + frontend workflows are actually serving before touching any code. After a project-task merge + post-merge they can be left fully NOT_STARTED.
---

# "App is slow" → first suspect is a dead/orphaned workflow, not the frontend

When a user reports the Replit *preview* is uniformly slow (multi-second page
loads, frozen shell, everything sluggish), the most common root cause is that a
workflow (api-server on its port, and/or the vite frontend) is **not actually
listening** — failed build, crashed, or orphaned process. The frontend's first
blocking call (`/api/me` in `AuthGate`) then hangs until proxy/connect timeout,
so the entire shell appears to take ~7s even though the code is fine.

**Why:** the trading-dashboard frontend is already heavily optimized (code-split
routes via wouter+React.lazy, lazy charts + Ruby assistant + admin pages,
skeleton-first render, polling paused on hidden tabs, client-side in-memory
symbol search). There is almost nothing left to "speed up" in the frontend — a
uniform slowdown is an infrastructure/serving symptom, not a render symptom.

A "the app won't start" report has the same first suspect: right after a
project-task merge + post-merge setup, the api-server and/or trading-dashboard
workflow is often left in **NOT_STARTED** (stopped, not crashed). Restart both
and re-verify serving BEFORE concluding the merged change caused a boot defect —
in practice it's almost always just the stopped workflows, and the merged code
builds + boots clean once restarted.

**How to apply:**
1. `refresh_all_logs` + curl `localhost:80/api/healthz`, `/`, `/api/me` through
   the shared proxy. If these hang or fail, the workflow is down. (If a workflow
   shows NOT_STARTED, that's the cause — just start it.)
2. Restart the api-server and frontend workflows (restarting api-server is
   safe and necessary; it does not touch live-broker config and the MT5 EA
   reconnects on its own heartbeat). Re-curl: healthy is ~3-8ms for
   healthz/index, ~3ms for the 401 on unauth `/api/me`.
3. Only after confirming serving, measure real interactive timing. Post-restart
   the backend endpoints are 5-30ms (candles ~170ms incl. provider), so any
   remaining "slow" interaction is harness overhead (Playwright char-by-char
   typing inflates client-side search to ~1.8s) or a real third-party call
   (e.g. Ruby's `/api/me/assistant/explain-signal` AI round-trip ~1.3s, which
   correctly shows an instant spinner).

Do NOT "fix" the client-side symbol search with a debounce/AbortController — it
runs synchronously against an in-memory registry with no network call; there is
nothing to debounce.
