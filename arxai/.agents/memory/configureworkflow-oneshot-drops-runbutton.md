---
name: configureWorkflow for one-shots clobbers .replit runButton
description: Side effect to avoid when running one-off scripts
---

- Using `configureWorkflow` + `removeWorkflow` to run a one-shot script dropped
  `runButton = "Project"` from the `[workflows]` section of `.replit`.
- It is NOT cleanly restorable: direct edits to `.replit` are blocked by the platform, no
  workflow tool/param exposes `runButton` (`configureWorkflow` has no such field), and
  `git restore`/`git checkout` are out-of-bounds in the bash sandbox.
- Impact is cosmetic — the Run-button binding only; all real workflows keep running.

**How to apply:** Never use workflows for one-off commands. Run one-offs in bash (the workflows
skill says this explicitly — workflows are for persistent processes only). If you need a
fresh-secret process specifically, weigh that the only fresh-secret path is a full Repl restart,
not a temporary workflow (which inherits the same stale snapshot anyway).
