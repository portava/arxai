---
name: Browser telemetry lifecycle
description: Lifecycle rules for module-scoped frontend performance timers and listeners.
---

Module-level browser telemetry may outlive a test document or replaced browser context. Keep the normal collection cadence and measurements while the owning document is active, then remove the timer and listeners when that document is no longer current.

**Why:** long frontend test runs let periodic telemetry callbacks fire after their browser document had been torn down, causing an unhandled reference error instead of a clean test exit.

**How to apply:** capture the owning window/document when installing browser observers, check that ownership before reading DOM state, and dispose the observer on context loss. Do not hide the error, skip the affected test, or disable active-page measurements.
