---
name: Measuring production timing in the dev environment
description: Why you cannot capture true browser-side production page/route timing for an artifact while in the dev environment, and what to measure instead.
---

# Measuring production-mode speed without publishing

When asked to prove an artifact is fast "in production" (not just Vite dev), you
cannot get a true browser-side production measurement inside the dev environment:

- The artifact's workflow (e.g. `artifacts/<slug>: web`) is **artifact-managed and
  cannot be overridden** via `configureWorkflow` — it returns
  `PROHIBITED_ACTION: ... managed by an artifact and cannot be overridden`. So you
  cannot swap its command from `dev` to `serve` (vite preview) to make the proxy
  serve the production build.
- You CAN run `vite preview` yourself on an alternate port (`PORT=5000 BASE_PATH=/
  pnpm --filter <pkg> run serve &`), but the shared proxy only routes the artifact
  path to the locked dev workflow port, and the test harness browser (runTest)
  **cannot reach a non-proxied `localhost:<altport>`** (`net::ERR_CONNECTION_REFUSED`).
  A non-proxied port also breaks the app's relative `/api/*` calls (no backend there).

**What to do instead (gives honest, concrete production evidence):**
1. Production **bundle analysis** — `vite build` and read chunk sizes. Confirms
   code-splitting and that the eager entry is small; production ships pre-built,
   minified, gzipped chunks with **no per-route on-demand compilation**.
2. **Loopback transport timing** — `curl -w` against the alt-port `vite preview`
   for the HTML and the main entry chunk (TTFB, total, gzip bytes). Real ms for
   download/transfer with zero compile cost.
3. Use **dev runTest walks** (logged in, mobile+desktop) as the dev baseline and
   for functional regression.

**Why:** The dev "1–3s" first-paint cost is dominated by Vite on-demand module
compilation + dev-only plugins (cartographer, dev-banner, runtime-error-overlay,
HMR, unminified source) — none of which exist in the production build. The only
way to get a real browser-side production number is to **publish/deploy** and run
runTest against the public domain.

**How to apply:** Don't waste time trying to swap the artifact workflow or point
runTest at a raw port. Reach for bundle + loopback-transport evidence, state the
methodology transparently, and note that publishing is the path to a true
end-to-end production measurement.
