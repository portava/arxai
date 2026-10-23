---
name: Workflow health detection in this sandbox
description: How to reliably detect a dead/orphaned workflow when socket introspection is restricted.
---

# Detecting a dead/orphaned workflow

`ss -ltnp` / `lsof` socket introspection is **restricted in this Replit
sandbox** — they return no rows for the artifact service ports even when the
services are up and answering. So port/PID enumeration is unreliable for
"is the workflow actually serving?".

**Rule:** the authoritative liveness signal is an HTTP GET through the shared
proxy (`http://localhost:80`). A dead/orphaned workflow cannot answer `200`
through the proxy (you get 502/timeout/connection error). Treat the proxy probe
as the required check; treat any `ss`/`lsof` PID/orphan detection as best-effort
enrichment that degrades cleanly to "introspection unavailable".

**Why:** the original ~7s "slow app" incident was dead api-server + frontend
workflows (not render speed) — the frontend's first blocking `/api` call hung
until proxy timeout. The fix is making that state loud (proxy probe + startup
readiness banner), not measuring sockets the sandbox won't expose.

**How to apply:** `pnpm run health:workflows` probes api-server `/api/healthz`,
frontend `/`, and the scanner candles auth gate via the proxy. An
unauthenticated `GET /api/data/candles` returning anything other than `401` is
an **auth regression** and must hard-fail (non-zero exit), not warn.
