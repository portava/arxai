// Dev-only scanner outage injection.
//
// PURPOSE: there is no way to make the real market-scanner read endpoints
// (`/market-scanner/status`, `/market-scanner/opportunities`) fail on demand,
// so the honest "Scanner is temporarily unavailable" degraded banner (which is
// hoisted to page scope so it shows on EVERY scanner tab, including the default
// Focus tab) cannot be visually confirmed end-to-end. This module lets QA arm a
// body-less 502 on those two read-only endpoints so the frontend's degrade path
// can be exercised against a live, authenticated session, then disarmed to prove
// the chart/cards recover on retry.
//
// SAFETY: this is HARD-GATED to non-production. In production
// (NODE_ENV === "production" AND ALLOW_DEV_AUTH !== "true") arming is impossible
// and the guard is a permanent no-op — it can never affect a real user. It only
// ever touches the two READ-ONLY scanner endpoints; it never reaches execution,
// gates, the brain, the EA/bridge, balances, or any DB write. Scanner reads are
// idempotent, so a forced 502 is indistinguishable from a transient upstream
// blip — exactly the failure the banner exists to communicate.

// Default from env so an operator can pre-arm a session before boot if desired,
// but the in-memory flag is the authoritative toggle so QA can flip it on/off
// within a single live test (env changes don't propagate to a running process).
let armed = process.env["SCANNER_OUTAGE_INJECT"] === "true";

// The injection may only ever fire in a dev/test environment. Read at call-time
// (like prodDevChecks.ts / auditVault.ts) so the gate is deterministic and
// mirrors the single dev-auth posture: production with ALLOW_DEV_AUTH unset can
// never arm.
export function isScannerOutageInjectionAllowed(): boolean {
  const isProd = String(process.env["NODE_ENV"] ?? "").toLowerCase() === "production";
  const allowDevAuth = process.env["ALLOW_DEV_AUTH"] === "true";
  return !isProd || allowDevAuth;
}

export function isScannerOutageArmed(): boolean {
  return armed && isScannerOutageInjectionAllowed();
}

export function setScannerOutageArmed(next: boolean): boolean {
  // Disarming is always honoured. Arming is only honoured where injection is
  // allowed, so a stray call in production stays a no-op.
  armed = next && isScannerOutageInjectionAllowed();
  return armed;
}
