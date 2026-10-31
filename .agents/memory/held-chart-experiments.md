---
name: Held chart experiments
description: Keep accepted chart feature imports separate from held layout and performance experiments.
---

Exclude held toolbar-layout, supporting-panel-containment experiments and other
held performance work from authorized chart feature imports.

**Why:** The owner explicitly excluded these experiments from the accepted
price-only scaling, manual parallel-channel and channel-extension update.

**How to apply:** Selectively import authorized feature changes rather than
assuming all ancestor tooling/layout work is approved. Keep held work separate
until the owner authorizes it; preserve newer local fixes and the recorder.

Assistant/Search/Quick Actions docking into the Smart Chart header is separately
authorized usability work. It does not authorize the held toolbar-row,
supporting-panel-containment or performance experiments.

**Why:** The owner explicitly requested this small control-placement batch while
continuing to exclude held experiments.

**How to apply:** Preserve the accepted dock in future imports without treating
that acceptance as permission to import other layout/performance branches.
