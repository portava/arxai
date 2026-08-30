// Smart "why am I blocked" explainer. Reads preflight, the risk governor, the
// readiness gate and the user's alerts. Strictly read-only — it evaluates
// nothing, arms nothing, and dispatches nothing.
//
// RANK 4 (critical) — this file's answer to "can I trade live?" was a lie.
//
// WHAT IT USED TO DO
//   explainBlockedAction() short-circuited ENABLE_LIVE_TRADING and
//   USE_BROKER_EXECUTION with:
//     "This app is PAPER_ONLY. The internal safety core does not allow live
//      trading."
//     "The broker connector is read-only."
//     technicalReasons: ["safetyCore.canPlaceTrades is hard-locked to false"]
//     recommendedFixes: ["... Live trading cannot be unlocked from this app."]
//   and line 67 hard-coded `const aaCanPlaceTrades = false;` which every other
//   branch then reported as fact. `liveTradingStatus` was the literal type
//   "DISABLED" — the shape could not express any other answer.
//
// WHY THAT MATTERS MORE THAN ANY OTHER COPY DEFECT
//   Real orders dispatch on this build. The user asking "why am I blocked from
//   live trading?" is exactly the user about to risk money, and the product
//   told them the question was meaningless. Worse, it destroyed the ONE tool
//   that could have helped them: the true answer is a specific, actionable list
//   ("your operator has not armed live execution", "an admin has not approved
//   you", "you have not accepted the risk disclosure"), and they got a flat
//   "impossible" instead.
//
// WHAT IT DOES NOW
//   Live actions are explained against the real chain, read per-user:
//     * global_trading_settings.platform_mode / live_enabled / kill switch
//     * user_trading_permissions.live_approved / trading_mode / suspended /
//       risk_disclosure_accepted_at
//     * arx_live_arming.is_armed
//     * the operator master switch (resolveLiveBrokerExecutionEnabledAsync)
//   Each unmet condition becomes one plain-English reason and one technical
//   reason. A read that fails is reported as UNKNOWN with the reason — never
//   silently downgraded to "blocked" or, worse, "allowed".
//
// It is also per-user now. It previously called preflight(), getActiveSession()
// and getCriticalUnread() with no userId at all, so one user's blocked-action
// explanation could be composed from another user's state.

import { randomUUID } from "node:crypto";
import { db, blockedActionExplanationsTable, globalTradingSettingsTable, userTradingPermissionsTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import { preflight, getActiveSession } from "../paperSession/manager.js";
import { evaluateGovernor } from "../riskGovernor/governor.js";
import { getGateStatus } from "../readiness/gate.js";
import { getCriticalUnread } from "../alerts/alertManager.js";
import { auditEvent } from "../systemHealth/audit.js";
import { getMyArming } from "../live/liveArming.js";
import { resolveLiveBrokerExecutionEnabledAsync } from "../live/phaseBConfig.js";

export type BlockedAction = "START_PAPER_SESSION" | "START_AUTOPILOT" | "OPEN_PAPER_TRADE" | "ENABLE_LIVE_TRADING" | "USE_BROKER_EXECUTION";
export type Severity = "INFO" | "WARN" | "BLOCK" | "CRITICAL";

/**
 * What we can say about live trading for this user right now.
 *  ALLOWED  — every prerequisite we can see is satisfied. (Per-order Phase B
 *             gates still apply — this is not a promise that a trade will go.)
 *  BLOCKED  — at least one prerequisite is unmet, and we name it.
 *  UNKNOWN  — a required read failed. We say so instead of guessing.
 */
export type LiveTradingStatus = "ALLOWED" | "BLOCKED" | "UNKNOWN";

export interface BlockedActionExplanation {
  explanation_id: string;
  blockedAction: BlockedAction;
  blockingSystems: string[];
  highestSeverity: Severity;
  plainEnglishReasons: string[];
  technicalReasons: string[];
  recommendedFixes: string[];
  safeNextStep: string;
  links: { label: string; href: string }[];
  liveTradingStatus: LiveTradingStatus;
  generatedAt: string;
}

// Every href below is a real <Route> AND on a human-trader allowlist
// (routeAccess.ts). The old list pointed at /trading-cockpit,
// /paper-testing-launch and /active-paper-session — none of which declare a
// route anywhere in App.tsx — and at /risk-settings, which is admin-only.
const COCKPIT_LINK = { label: "Cockpit", href: "/" };

function rank(s: Severity): number { return ({ INFO: 0, WARN: 1, BLOCK: 2, CRITICAL: 3 } as const)[s]; }
function highest(a: Severity, b: Severity): Severity { return rank(b) > rank(a) ? b : a; }

interface LiveReadiness {
  status: LiveTradingStatus;
  plain: string[];
  technical: string[];
  fixes: string[];
  /** True when at least one input could not be read. */
  degraded: boolean;
}

/**
 * The real live-trading prerequisite chain for one user.
 *
 * These are the account-level prerequisites, evaluated once. They are NOT the
 * per-order Phase B gates (symbol allowed, volume within max lot, stop-loss
 * present, EA heartbeat fresh, …) — those are evaluated against a specific
 * command at dispatch time and cannot be answered here, which the copy says.
 */
async function readLiveReadiness(userId: number): Promise<LiveReadiness> {
  const plain: string[] = [];
  const technical: string[] = [];
  const fixes: string[] = [];
  let degraded = false;

  const [globalRow, permRow, arming, operatorArmed] = await Promise.all([
    db.select({
      platformMode: globalTradingSettingsTable.platformMode,
      liveEnabled: globalTradingSettingsTable.liveEnabled,
      emergencyKillSwitch: globalTradingSettingsTable.emergencyKillSwitch,
    }).from(globalTradingSettingsTable).orderBy(asc(globalTradingSettingsTable.id)).limit(1)
      .then((r) => r[0] ?? null).catch(() => undefined),
    db.select({
      tradingMode: userTradingPermissionsTable.tradingMode,
      liveApproved: userTradingPermissionsTable.liveApproved,
      liveEnabled: userTradingPermissionsTable.liveEnabled,
      suspended: userTradingPermissionsTable.suspended,
      riskDisclosureAcceptedAt: userTradingPermissionsTable.riskDisclosureAcceptedAt,
    }).from(userTradingPermissionsTable).where(eq(userTradingPermissionsTable.userId, userId)).limit(1)
      .then((r) => r[0] ?? null).catch(() => undefined),
    getMyArming(userId).catch(() => undefined),
    resolveLiveBrokerExecutionEnabledAsync().catch(() => undefined),
  ]);

  // `undefined` = the read threw. `null` = it succeeded and there is no row,
  // which is a real, reportable answer (you have no permission record yet).
  if (globalRow === undefined || permRow === undefined || arming === undefined || operatorArmed === undefined) {
    degraded = true;
    technical.push("live readiness: one or more reads failed");
  }

  if (operatorArmed === false) {
    plain.push("Your operator has not armed live broker execution on this server. Nothing can reach a live broker until they do.");
    technical.push("liveBrokerExecutionEnabled=false");
    fixes.push("Ask your operator to arm live broker execution. This is not a setting you can change.");
  }
  if (globalRow && globalRow.emergencyKillSwitch === true) {
    plain.push("The platform emergency stop is engaged, so no new orders of any kind are accepted.");
    technical.push("globalTradingSettings.emergencyKillSwitch=true");
    fixes.push("Wait for your operator to clear the emergency stop.");
  }
  if (globalRow && (globalRow.platformMode ?? "").toUpperCase() !== "LIVE") {
    plain.push(`The platform is in ${String(globalRow.platformMode ?? "OFF").toUpperCase()} mode, not LIVE.`);
    technical.push(`globalTradingSettings.platformMode=${globalRow.platformMode}`);
  }
  if (globalRow && globalRow.liveEnabled === false) {
    plain.push("Live trading is switched off platform-wide.");
    technical.push("globalTradingSettings.liveEnabled=false");
  }
  if (permRow === null) {
    plain.push("You have no trading permission record yet, so no trading mode is granted to you.");
    technical.push("userTradingPermissions row missing");
    fixes.push("Complete onboarding and ask your operator to set your trading permissions.");
  } else if (permRow) {
    if (permRow.suspended === true) {
      plain.push("Your trading is currently suspended.");
      technical.push("userTradingPermissions.suspended=true");
      fixes.push("Contact your operator about the suspension on your account.");
    }
    if (permRow.liveApproved !== true) {
      plain.push("An admin has not approved you for live trading.");
      technical.push("userTradingPermissions.liveApproved=false");
      fixes.push("Request live approval from your operator once your readiness checks pass.");
    }
    if ((permRow.tradingMode ?? "").toUpperCase() !== "LIVE") {
      plain.push(`Your account's trading mode is ${String(permRow.tradingMode ?? "DISABLED").toUpperCase()}, not LIVE.`);
      technical.push(`userTradingPermissions.tradingMode=${permRow.tradingMode}`);
    }
    if (permRow.riskDisclosureAcceptedAt == null) {
      plain.push("You have not accepted the live risk disclosure.");
      technical.push("userTradingPermissions.riskDisclosureAcceptedAt=null");
      fixes.push("Read and accept the live risk disclosure on your Account page.");
    }
  }
  if (arming === null || (arming && arming.isArmed !== true)) {
    plain.push("You have not armed your own account for live execution.");
    technical.push("arxLiveArming.isArmed=false");
    fixes.push("Arm live execution from the Live Trading page once every other condition is met.");
  }

  const status: LiveTradingStatus =
    degraded ? "UNKNOWN" : plain.length > 0 ? "BLOCKED" : "ALLOWED";
  return { status, plain, technical, fixes, degraded };
}

export async function explainBlockedAction(action: BlockedAction, userId: number): Promise<BlockedActionExplanation> {
  // Live actions: answer with the real chain instead of a flat "impossible".
  if (action === "ENABLE_LIVE_TRADING" || action === "USE_BROKER_EXECUTION") {
    const live = await readLiveReadiness(userId);
    const plain = [...live.plain];
    const fixes = [...live.fixes];
    if (live.status === "UNKNOWN") {
      plain.unshift("We could not read every part of your live-trading status, so we cannot tell you whether live trading is available to you right now. Treat this as unknown, not as safe.");
      fixes.unshift("Reload this page. If it keeps failing, contact your operator before attempting any live action.");
    } else if (live.status === "ALLOWED") {
      plain.push("Every account-level prerequisite for live trading is satisfied on your account.");
      plain.push("Each individual order is still evaluated against the Phase B safety gates at dispatch time — symbol, volume, stop-loss, daily loss, bridge heartbeat and more. A gate can still refuse a specific trade.");
      fixes.push("Review each order carefully before approving it. On a live-armed account, a confirmation risks real money.");
    }
    return persist({
      explanation_id: `expl_${randomUUID()}`,
      blockedAction: action,
      blockingSystems: ["LIVE_GATE_CHAIN"],
      highestSeverity: live.status === "ALLOWED" ? "INFO" : live.status === "UNKNOWN" ? "WARN" : "BLOCK",
      plainEnglishReasons: plain,
      technicalReasons: live.technical,
      recommendedFixes: fixes.length > 0 ? fixes : ["No action required."],
      safeNextStep:
        live.status === "ALLOWED"
          ? "Open Live Trading and review your risk settings before placing anything."
          : live.status === "UNKNOWN"
            ? "Do not attempt a live action until your status can be read."
            : "Work through the listed conditions. Two of them can only be changed by your operator.",
      links: [COCKPIT_LINK, { label: "Account", href: "/my-account" }, { label: "Risk", href: "/risk-command-center" }],
      liveTradingStatus: live.status,
      generatedAt: new Date().toISOString(),
    });
  }

  const [pre, active, gov, gate, critical, live] = await Promise.all([
    // userId on both: front B made these per-user. Without it this helper read
    // whichever ACTIVE session existed on the instance and explained a
    // stranger's state back to the caller — the exact leak B closed.
    preflight(userId).catch(() => null),
    getActiveSession(userId).catch(() => null),
    evaluateGovernor({ userId }).catch(() => null),
    getGateStatus().catch(() => null),
    getCriticalUnread(userId).catch(() => []),
    readLiveReadiness(userId).catch((): LiveReadiness => ({ status: "UNKNOWN", plain: [], technical: [], fixes: [], degraded: true })),
  ]);

  const blockingSystems = new Set<string>();
  const plain: string[] = [];
  const technical: string[] = [];
  const fixes: string[] = [];
  const links: { label: string; href: string }[] = [COCKPIT_LINK];
  let severity: Severity = "INFO";
  let safeNextStep = "Open the Cockpit for next steps.";

  if (critical.length > 0) {
    blockingSystems.add("ALERTS");
    plain.push(`There ${critical.length === 1 ? "is" : "are"} ${critical.length} unacknowledged critical safety alert${critical.length === 1 ? "" : "s"}.`);
    technical.push(`alertManager.getCriticalUnread().length=${critical.length}`);
    fixes.push("Open Notifications and acknowledge critical alerts.");
    links.push({ label: "Notifications", href: "/notifications" });
    severity = highest(severity, "CRITICAL");
    safeNextStep = "Acknowledge critical alerts before starting anything.";
  }

  if (gate?.currentStatus === "FAIL" || gate?.currentStatus === "BLOCKED") {
    blockingSystems.add("READINESS");
    plain.push(`Your readiness gate is ${gate.currentStatus}. Required checks have not passed.`);
    technical.push(`readinessGate.currentStatus=${gate.currentStatus}, score=${gate.readinessScore}, grade=${gate.readinessGrade}`);
    fixes.push("Open ARX Status and resolve the failed readiness checks.");
    links.push({ label: "ARX Status", href: "/status-command-center" });
    severity = highest(severity, "BLOCK");
    safeNextStep = "Fix the readiness items, then try again.";
  }

  if (gov && (gov.overallStatus === "PAPER_PAUSED" || gov.overallStatus === "WATCH_ONLY" || gov.overallStatus === "LOCKED")) {
    blockingSystems.add("RISK_GOVERNOR");
    plain.push(`The Risk Governor is ${gov.overallStatus}. New activity is restricted.`);
    technical.push(`riskGovernor.overallStatus=${gov.overallStatus}, hardBlocks=${gov.hardBlocks?.length ?? 0}`);
    fixes.push("Wait for governor cooldowns to clear, or resolve the flagged risk rules.");
    links.push({ label: "Risk", href: "/risk-command-center" });
    severity = highest(severity, "BLOCK");
    safeNextStep = "Review the Risk command center and wait for the status to clear.";
  }

  if (action === "START_AUTOPILOT") {
    if (!active) {
      blockingSystems.add("SESSION");
      plain.push("Autopilot needs an ACTIVE practice session and there is none.");
      technical.push("session.active=null");
      fixes.push("Start a session first, then enable autopilot.");
      severity = highest(severity, "BLOCK");
      safeNextStep = "Start a session, then revisit autopilot.";
    } else if (gov && !gov.autopilotAllowed) {
      blockingSystems.add("RISK_GOVERNOR");
      plain.push("Autopilot is gated off by the Risk Governor.");
      technical.push("riskGovernor.autopilotAllowed=false");
      fixes.push("Resolve the risk flags. Autopilot re-enables when allowed.");
      severity = highest(severity, "BLOCK");
    }
  }

  if (action === "OPEN_PAPER_TRADE" && !active) {
    blockingSystems.add("SESSION");
    plain.push("Practice execution requires an ACTIVE session.");
    technical.push("session.active=null");
    fixes.push("Start a session first.");
    severity = highest(severity, "BLOCK");
    safeNextStep = "Start a session.";
  }

  if (action === "START_PAPER_SESSION" && active) {
    blockingSystems.add("SESSION");
    plain.push("Only one ACTIVE session may exist at a time. Close the current one before starting a new one.");
    technical.push(`session.active.status=${active.status}`);
    fixes.push("End the current session, then start a new one.");
    severity = highest(severity, "BLOCK");
    safeNextStep = "End the current session before starting a new one.";
  }

  if (pre && !pre.paperTestingAllowed && (pre.hardBlocks?.length ?? 0) > 0) {
    blockingSystems.add("PREFLIGHT");
    for (const b of pre.hardBlocks) {
      plain.push(`Preflight blocker: ${b.message}`);
      technical.push(`preflight.${b.source}.${b.code}`);
    }
    severity = highest(severity, "BLOCK");
  }

  // The real live status is reported as CONTEXT on non-live actions — never as
  // the fabricated constant "canPlaceTrades=false" the old code emitted.
  technical.push(`liveTradingStatus=${live.status}`);

  if (plain.length === 0) {
    plain.push("No blocking conditions found for this action.");
    safeNextStep = "Try the action again from the Cockpit.";
  }

  return persist({
    explanation_id: `expl_${randomUUID()}`,
    blockedAction: action,
    blockingSystems: [...blockingSystems],
    highestSeverity: severity,
    plainEnglishReasons: plain,
    technicalReasons: technical,
    recommendedFixes: fixes.length > 0 ? fixes : ["No fix required — try the action again."],
    safeNextStep,
    links,
    liveTradingStatus: live.status,
    generatedAt: new Date().toISOString(),
  });
}

async function persist(e: BlockedActionExplanation): Promise<BlockedActionExplanation> {
  await db.insert(blockedActionExplanationsTable).values({
    explanationId: e.explanation_id,
    blockedAction: e.blockedAction,
    blockingSystems: e.blockingSystems,
    highestSeverity: e.highestSeverity,
    plainEnglishReasons: e.plainEnglishReasons,
    technicalReasons: e.technicalReasons,
    recommendedFixes: e.recommendedFixes,
    safeNextStep: e.safeNextStep,
    links: e.links,
  }).catch(() => {});
  if (e.highestSeverity === "BLOCK" || e.highestSeverity === "CRITICAL") {
    await auditEvent({ eventType: "WHY_BLOCKED", action: `whyBlocked.${e.blockedAction}`, sourceBuild: "MM", actor: "USER", severity: e.highestSeverity === "CRITICAL" ? "CRITICAL" : "WARNING", metadata: { build: "RR", action: e.blockedAction, systems: e.blockingSystems } }).catch(() => {});
    // NOTE: this used to also createAlert() into the legacy `alerts` table on
    // every blocked explanation. That table has no read surface anywhere in the
    // app (routes/alerts.ts is fully deprecated), so the write only produced an
    // alert nobody could open. Merely ASKING why you are blocked is also not an
    // alertable event. The audit trail above is retained.
  }
  return e;
}

export interface TopicExplanation {
  help_id: string;
  topic: string;
  status: string;
  plainEnglishExplanation: string;
  reasonCodes: string[];
  recommendedNextActions: string[];
  relatedPages: string[];
  safetyReminder: string;
  generatedAt: string;
}

const SAFETY_REMINDER =
  "Live dispatch is default-deny: your operator must arm it, an admin must approve you, you must arm your own account and accept the risk disclosure, and every Phase B gate must pass for that specific order.";

function topic(
  topicText: string,
  status: string,
  explanation: string,
  reasonCodes: string[],
  actions: string[],
  pages: string[],
): TopicExplanation {
  return {
    help_id: `help_${randomUUID()}`,
    topic: topicText,
    status,
    plainEnglishExplanation: explanation,
    reasonCodes,
    recommendedNextActions: actions,
    relatedPages: pages,
    safetyReminder: SAFETY_REMINDER,
    generatedAt: new Date().toISOString(),
  };
}

export async function explainTopic(topicText: string, userId: number): Promise<TopicExplanation> {
  const t = (topicText || "").toLowerCase();

  const fromAction = async (action: BlockedAction) => {
    const exp = await explainBlockedAction(action, userId);
    return topic(
      topicText,
      exp.highestSeverity,
      exp.plainEnglishReasons.join(" "),
      exp.technicalReasons,
      exp.recommendedFixes,
      exp.links.map((l) => l.href),
    );
  };

  if (t.includes("can't start") || t.includes("cannot start") || t.includes("session")) return fromAction("START_PAPER_SESSION");
  if (t.includes("autopilot")) return fromAction("START_AUTOPILOT");
  if (t.includes("rejected") || t.includes("open a trade")) return fromAction("OPEN_PAPER_TRADE");

  // RANK 4 — these three branches previously answered with the PAPER_ONLY lie:
  //   "The broker connector is read-only. Live execution is disabled in this app."
  //   "This app is PAPER_ONLY. Live trading cannot be enabled from here, by design."
  // They now answer from the user's real state.
  if (t.includes("broker") || t.includes("read-only") || t.includes("readonly") || t.includes("bridge")) {
    return fromAction("USE_BROKER_EXECUTION");
  }
  if (t.includes("live") || t.includes("disabled") || t.includes("real money")) {
    return fromAction("ENABLE_LIVE_TRADING");
  }

  if (t.includes("hold") || t.includes("why no signal")) {
    return topic(topicText, "INFO",
      "The analyser returns HOLD when it does not see a setup that meets its own thresholds. HOLD is the safe default, not a failure.",
      ["confidence<threshold"],
      ["Wait for a higher-confidence setup.", "Do not lower a threshold to manufacture a signal."],
      ["/", "/market-scanner"]);
  }
  if (t.includes("market data") || t.includes("degraded") || t.includes("stale")) {
    return topic(topicText, "WARN",
      "Market data is DEGRADED when the feed is stale, spreads are abnormal or candles are missing. ARX becomes more conservative rather than filling the gap with a guess, and shows an unavailable price as unavailable.",
      ["marketData.status=DEGRADED"],
      ["Wait for the feed to recover.", "Do not run automation on a degraded feed."],
      ["/live-chart", "/status-command-center"]);
  }
  if (t.includes("risk") || t.includes("limit")) {
    return topic(topicText, "INFO",
      "Reducing a risk limit applies immediately. Raising one is queued for 24 hours and must be confirmed again before it takes effect — until then the old, tighter limit is what is in force.",
      ["riskVault.delayedIncrease"],
      ["Open the Risk command center to see any pending increases and when they can be confirmed."],
      ["/risk-command-center"]);
  }
  if (t.includes("safest") || t.includes("next step") || t.includes("what should")) {
    return topic(topicText, "INFO",
      "The safest next step is whatever ARX Status lists as your next unmet item. It already accounts for alerts, readiness and risk.",
      ["nextBestAction"],
      ["Open ARX Status and follow the first unmet item."],
      ["/status-command-center", "/"]);
  }
  return topic(topicText, "INFO",
    "No matching explanation. Try one of: 'why can't I start a session', 'why is autopilot blocked', 'why can't I use the broker bridge', 'why can't I trade live', 'what should I do next'.",
    [],
    ["Browse the Help Center topics below."],
    ["/help"]);
}
