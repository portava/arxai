---
name: API test process lifecycle
description: Avoid worker leaks when a test starts the API application in-process.
---

Importing the API application starts long-lived background workers. Closing the HTTP listener and database pool does not necessarily stop those workers.

**Why:** An in-process browser test initially kept running after its checks because worker timers continued firing and attempting scheduled database work.

**How to apply:** Run app-starting integration checks in a dedicated child process, close browser and server resources, clean up fixtures, and explicitly exit after success or failure.
