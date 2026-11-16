---
name: Specialist panel lifecycle
description: Collapsing stateful specialist workspaces must not discard drafts or interrupt running views.
---

Keep stateful Testing Lab content mounted while collapsed; hide it from interaction and accessibility rather than resetting its component lifecycle. Leave tab-switch lifecycle behavior unchanged.

**Why:** Saving panel visibility must not discard a user's test parameters, selections, or active view state. This layout task does not authorize changing test execution behavior.

**How to apply:** Use opt-in mount preservation when adopting collapsible layouts around stateful forms or running views. Read-only report sections can retain the existing unmount-on-collapse behavior.
