---
name: Nested import routing
description: Why imported ARX source stays nested while preview metadata belongs at the workspace's top-level artifact path.
---

Keep imported application source in its original workspace, but expose it through
a single top-level artifact registration and a narrow launcher. Preserve the
artifact ID and avoid duplicate manifests or legacy workflows.

**Why:** In this environment a registered nested artifact successfully started
Vite on the injected port and address, but the shared router still returned 404.
Refreshing metadata and restarting did not help. Relocating the sole manifest to
the top-level artifact layout immediately restored forwarding without rewriting
the imported application.

**How to apply:** When a nested import responds directly but fails through the
shared router, distinguish workflow registration from router discovery. Prefer a
top-level routing adapter over moving application code or adding proxy servers.
Use validated manifest updates and verify through the shared router and a
screenshot, not just the underlying service port.
