---
name: Validation process lifecycle
description: Own API-test workers and offline fixture lifetimes across tool invocations.
---

Importing the API application starts long-lived background workers. Closing the HTTP listener and database pool does not necessarily stop those workers.

**Why:** An in-process browser test initially kept running after its checks because worker timers continued firing and attempting scheduled database work.

**How to apply:** Run app-starting integration checks in a dedicated child process, close browser and server resources, clean up fixtures, and explicitly exit after success or failure.

An offline fixture must have an owner whose lifetime spans the browser checks;
do not assume a background child survives a short-lived launching shell.

**Why:** A fixture ended with its launching shell and subsequent browser setups
failed before assertions. A runner-owned fixture survived the full browser pass.

**How to apply:** Use an explicitly managed background task or a runner-owned
child, retain its startup/exit logs, and close only those owned resources.
Connection refusal at the synthetic fixture is not evidence that the real API
needs restarting or that application assertions failed.
