// stop-controls.honesty.test.tsx — every stop control names what it halts.
//
// This platform has FOUR kill-switch surfaces and none of them used to say
// which dispatch path it gated (audit rank 58): /emergency (safety-core),
// /live-trading-control (the micro-live approval subsystem, whose terminal
// action ALWAYS returns REJECTED with BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED),
// /live-trading (per-user arming — the one the pipeline reads) and
// /protective-auto-close. An operator looking for the stop button found four,
// picked the wrong one, and got a green KILL_ENGAGED from a subsystem that
// cannot place an order in the first place.
//
// The claims pinned here, one per audit finding:
//   rank 5  — the Risk Settings emergency stop no longer promises to cancel trades
//   rank 23 — the Risk Command Center pause no longer claims to halt every dispatch surface
//   rank 58 — each remaining stop surface names its own reach; no self-granted ADMIN header
//   rank 61 — protective auto-close separates fixed SYSTEM LOCKS from real gate checks
//   rank 62 — the risk event log reads the durable per-user table, not a global ring buffer
//   rank 82 — /prop-firm-mode no longer writes a process-global challenge shared by all users
//
// Source-level assertions are the right instrument for most of these: the
// defect was a sentence, and a sentence that has been deleted cannot be proven
// gone by rendering one state of one component.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";

vi.mock("lucide-react", () => {
  const Stub = () => null;
  return { Trophy: Stub, ArrowRight: Stub };
});

import PropFirmMode from "./prop-firm-mode";

const PAGES = path.resolve(__dirname);
const read = (f: string) => fs.readFileSync(path.join(PAGES, f), "utf8");

afterEach(() => cleanup());

describe("rank 5 — the Risk Settings emergency stop does not promise a close", () => {
  const src = read("risk-settings.tsx");

  it("no longer claims it cancels open trades", () => {
    // The server used to overwrite OPEN `trades` rows as CANCELLED / pnl 0 with
    // no broker command anywhere. Both the write and the promise are gone.
    expect(src).not.toContain("Cancel every open mock trade");
  });

  it("says plainly that nothing is closed", () => {
    expect(src).toMatch(/does <strong>not<\/strong> close anything/);
    expect(src).toMatch(/no close\s*\n?\s*command is sent to your broker/);
  });

  it("names what it does halt", () => {
    expect(src).toMatch(/Engage the platform kill switch/);
  });
});

describe("rank 23 — the Risk Command Center pause states its real reach", () => {
  const src = read("risk-command-center.tsx");

  it("drops the 'halts every dispatch surface' claim", () => {
    // POST /api/risk/pause sets one module-level boolean whose only readers are
    // the simulator pre-trade check and the simulator OMS.
    expect(src).not.toContain("halts every dispatch surface");
  });

  it("names the simulator as its scope and points at the real stop", () => {
    expect(src).toContain("simulator order flow only");
    expect(src).toMatch(/Pause does not stop:/);
    expect(src).toContain('href="/emergency"');
  });

  it("discloses that the pause is process-wide and lost on restart", () => {
    expect(src).toMatch(/process-wide \(not per user\) and is lost when the server restarts/);
  });
});

describe("rank 58 — each stop surface names the dispatch path it gates", () => {
  it("/emergency lists what the safety-core switch stops and does not stop", () => {
    const src = read("emergency.tsx");
    expect(src).toContain("What this switch stops");
    expect(src).toContain("What it does not do");
    expect(src).toMatch(/MT5 live command dispatch/);
    expect(src).toMatch(/Deriv guided dispatch path/);
    expect(src).toMatch(/It does not close anything/);
    // The old blanket claim is gone.
    expect(src).not.toContain("blocks all execution");
  });

  it("/live-trading-control admits its kill switch gates a stubbed path", () => {
    const src = read("live-trading-control.tsx");
    expect(src).toContain("Which stop is this?");
    expect(src).toContain("BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED");
    expect(src).toMatch(/micro-live approval subsystem/);
    expect(src).toContain('href="/emergency"');
  });

  it("/live-trading-control no longer grants itself ADMIN", () => {
    const src = read("live-trading-control.tsx");
    // `x-security-role` is a dev-only back-compat fallback. A page that sends
    // it promotes every visitor to ADMIN wherever it is honoured.
    expect(src).not.toMatch(/"x-security-role"\s*:/);
    expect(src).not.toMatch(/const ROLE = "ADMIN"/);
  });

  it("/live-trading-control reports outcomes as sentences, not raw JSON", () => {
    const src = read("live-trading-control.tsx");
    expect(src).not.toMatch(/JSON\.stringify\(j\.result/);
    expect(src).toMatch(/requires an ADMIN or OWNER role/);
  });

  it("/live-trading's per-user arming switch names its scope", () => {
    const src = fs.readFileSync(
      path.resolve(PAGES, "../components/live/LiveKillSwitchButton.tsx"),
      "utf8",
    );
    expect(src).toMatch(/your account only<\/strong> — it halts your live order dispatch/);
    expect(src).toContain('href="/emergency"');
  });

  it("/protective-auto-close names its kill switch's scope", () => {
    const src = read("protective-auto-close.tsx");
    expect(src).toContain("Engage auto-close kill switch");
    expect(src).toMatch(/This switch stops:<\/strong> Protective Auto-Close decisions for your account only/);
    expect(src).toMatch(/It does not stop:<\/strong> any order dispatch/);
  });
});

describe("rank 61 — protective auto-close separates system locks from gate checks", () => {
  const src = read("protective-auto-close.tsx");

  it("no longer renders a hardcoded false as a live bridge status read", () => {
    // "Broker bridge connected → ok:false" told a user with a healthy MT5
    // bridge that the bridge was down.
    expect(src).not.toContain('{ label: "Broker bridge connected", ok: false');
    expect(src).not.toContain('{ label: "Live execution unlocked", ok: false');
  });

  it("labels the two fixed constraints as SYSTEM LOCKs", () => {
    expect(src).toContain("SYSTEM LOCK");
    expect(src).toContain("const systemLocks");
    expect(src).toMatch(/System locks \(fixed in this build\)/);
  });

  it("states that ALERT_ONLY is fixed, not the outcome of a failing check", () => {
    expect(src).toMatch(/const effectiveStatus: "ALERT_ONLY" \| "ARMED" = "ALERT_ONLY"/);
    expect(src).toMatch(/Alert Only — and fixed that way in this build/);
  });

  it("marks the unreachable modes as inert instead of offering them as policy", () => {
    expect(src).toContain("CONFIRM_IF_ACTIVE — inert in this build");
    expect(src).toContain("AUTO_IF_INACTIVE — inert in this build");
  });
});

describe("rank 62 — the risk event log is durable and per-user", () => {
  const src = read("risk-events.tsx");

  it("reads the per-user endpoint, not the global ring buffer", () => {
    expect(src).toContain("/api/me/risk/events");
    expect(src).not.toContain('fetch("/api/risk/events');
  });

  it("drops the audit-vault claim and points at the real audit log", () => {
    expect(src).not.toContain("Source of truth for the audit vault");
    expect(src).toMatch(/This is not the audit vault/);
    expect(src).toContain('href="/audit-log"');
  });

  it("degrades a failed read to a reason, never to an empty list", () => {
    expect(src).toMatch(/Could not load your risk events/);
    expect(src).toMatch(/Sign in to see your risk events/);
  });
});

describe("rank 82 — /prop-firm-mode no longer edits a challenge shared by everyone", () => {
  const src = read("prop-firm-mode.tsx");

  it("issues no writes to the process-global prop-firm object", () => {
    expect(src).not.toContain("/api/prop-firm/configure");
    expect(src).not.toContain("/api/prop-firm/reset");
    expect(src).not.toContain("/api/prop-firm/status");
  });

  it("no longer grants itself ADMIN via a client header", () => {
    expect(src).not.toMatch(/"x-security-role"/);
  });

  it("renders an explanation and routes to the per-account challenge", () => {
    render(<PropFirmMode />);
    expect(screen.getByTestId("prop-firm-mode-retired")).toBeTruthy();
    const link = screen.getByTestId("link-prop-challenge") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/prop-challenge");
  });
});
