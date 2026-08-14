---
name: lightweight-charts ResizeObserver disposal guard
description: Every lightweight-charts consumer's RO callback needs a disposed flag + try/catch, or a late callback after chart.remove() throws "Object is disposed" into window.onerror.
---

**Rule:** Any component or adapter that creates a lightweight-charts chart AND a
ResizeObserver that calls `chart.applyOptions(...)` must (1) set a `disposed`
flag in cleanup BEFORE `ro.disconnect()`/`chart.remove()`, (2) short-circuit
the RO callback on that flag, and (3) wrap `applyOptions` in try/catch. Wrap
`chart.remove()` in try/catch too.

**Why:** A ResizeObserver callback already queued before `disconnect()` still
fires after `chart.remove()`. fancy-canvas then throws "Object is disposed"
asynchronously — it surfaces via `window.onerror` with an EMPTY stack,
uncatchable by React error boundaries, and trips the Vite dev runtime-error
overlay. This bug was fixed in the main scanner chart panel but silently
recurred in a mini-chart component that drifted from the pattern (its effect
rebuilt the chart on every candle poll, making the race easy to hit).

**How to apply:** When adding ANY new lightweight-charts consumer, copy the
guarded teardown pattern (disposed flag → disconnect → guarded remove) rather
than a bare `return () => { ro.disconnect(); chart.remove(); }`. A jsdom
regression test exists that replays a captured RO callback after unmount and
asserts no-throw — mirror it for new consumers. Diagnostic tell: dev overlay
"Object is disposed" with an empty/blank stack ⇒ hunt for an unguarded RO or
rAF callback touching a removed chart. Related: `clearTimeout` cannot cancel a
rAF that a fired timeout already scheduled — polling loops built as
setTimeout→rAF chains need a `stopped` flag checked at tick entry or they
re-arm forever after cleanup.
