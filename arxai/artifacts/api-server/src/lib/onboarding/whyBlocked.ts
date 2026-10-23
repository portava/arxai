// Build RR — Smart "why am I blocked" explainer.
// Reads from PP preflight, HH governor, OO gate, LL alerts. Read-only.

import { randomUUID } from "node:crypto";
import { db, blockedActionExplanationsTable } from "@workspace/db";
import { preflight, getActiveSession } from "../paperSession/manager.js";
import { evaluateGovernor } from "../riskGovernor/governor.js";
import { getGateStatus } from "../readiness/gate.js";
import { getCriticalUnread } from "../alerts/alertManager.js";
import { auditEvent } from "../systemHealth/audit.js";
import { createAlert } from "../alerts/alertManager.js";

export type BlockedAction = "START_PAPER_SESSION" | "START_AUTOPILOT" | "OPEN_PAPER_TRADE" | "ENABLE_LIVE_TRADING" | "USE_BROKER_EXECUTION";
export type Severity = "INFO" | "WARN" | "BLOCK" | "CRITICAL";

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
  liveTradingStatus: "DISABLED";
  generatedAt: string;
}

const LIVE_LINKS = [{ label: "Trading Cockpit", href: "/trading-cockpit" }];

function rank(s: Severity): number { return ({ INFO: 0, WARN: 1, BLOCK: 2, CRITICAL: 3 } as const)[s]; }
function highest(a: Severity, b: Severity): Severity { return rank(b) > rank(a) ? b : a; }

export async function explainBlockedAction(action: BlockedAction): Promise<BlockedActionExplanation> {
  // Live trading + broker execution are PERMANENTLY disabled. Short-circuit.
  if (action === "ENABLE_LIVE_TRADING" || action === "USE_BROKER_EXECUTION") {
    return persist({
      explanation_id: `expl_${randomUUID()}`,
      blockedAction: action,
      blockingSystems: ["AA", "NN"],
      highestSeverity: "BLOCK",
      plainEnglishReasons: [
        "This app is PAPER_ONLY. The internal safety core does not allow live trading.",
        "The broker connector is read-only.",
      ],
      technicalReasons: ["safetyCore.canPlaceTrades is hard-locked to false", "NN forbidden permissions reject live execution"],
      recommendedFixes: ["Use a paper session to practice. Live trading cannot be unlocked from this app."],
      safeNextStep: "Open the Trading Cockpit and start a paper session.",
      links: LIVE_LINKS,
      liveTradingStatus: "DISABLED",
      generatedAt: new Date().toISOString(),
    });
  }

  const [pre, active, gov, gate, critical] = await Promise.all([
    preflight().catch(() => null),
    getActiveSession().catch(() => null),
    evaluateGovernor().catch(() => null),
    getGateStatus().catch(() => null),
    getCriticalUnread().catch(() => []),
  ]);

  // AA — safety core / decision orchestrator. canPlaceTrades is permanently
  // hard-locked to false in this app. Surface AA as a first-class signal in
  // every blocked-action explanation so users understand the global gate.
  const aaCanPlaceTrades = false; // safetyCore.canPlaceTrades (PAPER_ONLY)

  const blockingSystems = new Set<string>();
  const plain: string[] = [];
  const technical: string[] = [];
  const fixes: string[] = [];
  const links: { label: string; href: string }[] = [{ label: "Trading Cockpit", href: "/trading-cockpit" }];
  let severity: Severity = "INFO";
  let safeNextStep = "Open the Trading Cockpit for next steps.";

  if (critical.length > 0) {
    blockingSystems.add("LL");
    plain.push(`There ${critical.length === 1 ? "is" : "are"} ${critical.length} unacknowledged critical safety alert${critical.length === 1 ? "" : "s"}.`);
    technical.push(`alertManager.getCriticalUnread().length=${critical.length}`);
    fixes.push("Open Notifications and acknowledge critical alerts.");
    links.push({ label: "Notifications", href: "/notifications" });
    severity = highest(severity, "CRITICAL");
    safeNextStep = "Acknowledge critical alerts before starting a session.";
  }

  if (gate?.currentStatus === "FAIL" || gate?.currentStatus === "BLOCKED") {
    blockingSystems.add("OO");
    plain.push(`Readiness Gate is ${gate.currentStatus}. Required checks have not passed.`);
    technical.push(`readinessGate.currentStatus=${gate.currentStatus}, score=${gate.readinessScore}, grade=${gate.readinessGrade}`);
    fixes.push("Open the Readiness Gate page and resolve the failed checks.");
    links.push({ label: "Readiness Gate", href: "/readiness-checklist" });
    severity = highest(severity, "BLOCK");
    safeNextStep = "Fix the readiness gate items, then re-run preflight.";
  }

  if (gov && (gov.overallStatus === "PAPER_PAUSED" || gov.overallStatus === "WATCH_ONLY" || gov.overallStatus === "LOCKED")) {
    blockingSystems.add("HH");
    plain.push(`Risk Governor is ${gov.overallStatus}. New paper activity is restricted.`);
    technical.push(`riskGovernor.overallStatus=${gov.overallStatus}, hardBlocks=${gov.hardBlocks?.length ?? 0}`);
    fixes.push("Wait for governor cooldowns to clear or resolve flagged risk rules.");
    links.push({ label: "Risk Governor", href: "/risk-settings" });
    severity = highest(severity, "BLOCK");
    safeNextStep = "Review the Risk Governor page and wait for status to clear.";
  }

  if (action === "START_AUTOPILOT") {
    if (!active) {
      blockingSystems.add("PP");
      plain.push("Autopilot needs an ACTIVE paper session and there is none.");
      technical.push("paperSession.active=null");
      fixes.push("Start a paper session first, then enable autopilot.");
      links.push({ label: "Paper Sessions", href: "/paper-testing-launch" });
      severity = highest(severity, "BLOCK");
      safeNextStep = "Start a paper session, then revisit autopilot.";
    } else if (gov && !gov.autopilotAllowed) {
      blockingSystems.add("HH");
      plain.push("Autopilot is gated off by the Risk Governor.");
      technical.push("riskGovernor.autopilotAllowed=false");
      fixes.push("Resolve risk flags. Autopilot will re-enable when allowed.");
      severity = highest(severity, "BLOCK");
    }
  }

  if (action === "OPEN_PAPER_TRADE") {
    if (!active) {
      blockingSystems.add("PP");
      plain.push("Paper execution requires an ACTIVE paper session.");
      technical.push("paperSession.active=null");
      fixes.push("Start a paper session first.");
      links.push({ label: "Paper Sessions", href: "/paper-testing-launch" });
      severity = highest(severity, "BLOCK");
      safeNextStep = "Start a paper session.";
    }
  }

  if (action === "START_PAPER_SESSION" && active) {
    blockingSystems.add("PP");
    plain.push("Only one ACTIVE paper session may exist at a time. Close the current one before starting a new one.");
    technical.push(`paperSession.active.status=${active.status}`);
    fixes.push("End the current session, then start a new one.");
    links.push({ label: "Active Session", href: "/active-paper-session" });
    severity = highest(severity, "BLOCK");
    safeNextStep = "End the current paper session before starting a new one.";
  }

  if (pre && !pre.paperTestingAllowed && (pre.hardBlocks?.length ?? 0) > 0) {
    blockingSystems.add("PP");
    for (const b of pre.hardBlocks) {
      plain.push(`Preflight blocker: ${b.message}`);
      technical.push(`preflight.${b.source}.${b.code}`);
    }
    severity = highest(severity, "BLOCK");
  }

  // AA always present as advisory context — confirms live trading is hard-locked.
  blockingSystems.add("AA");
  technical.push(`safetyCore.canPlaceTrades=${aaCanPlaceTrades}`);
  if (action === "START_PAPER_SESSION" || action === "START_AUTOPILOT" || action === "OPEN_PAPER_TRADE") {
    technical.push("AA.appMode=PAPER_ONLY (live trading hard-locked off, paper actions allowed when other gates pass)");
  }

  if (plain.length === 0) {
    plain.push("No blocking conditions found. The action should be allowed in the cockpit.");
    safeNextStep = "Try the action from the Trading Cockpit.";
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
    liveTradingStatus: "DISABLED",
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
    await createAlert({ type: "AI_COACH", priority: e.highestSeverity === "CRITICAL" ? "CRITICAL" : "MEDIUM", title: `Action blocked: ${e.blockedAction}`, message: e.plainEnglishReasons[0] ?? "Action blocked." }).catch(() => {});
  }
  return e;
}

export async function explainTopic(topic: string): Promise<{ help_id: string; topic: string; status: string; plainEnglishExplanation: string; reasonCodes: string[]; recommendedNextActions: string[]; relatedPages: string[]; safetyReminder: string; generatedAt: string }> {
  const t = (topic || "").toLowerCase();
  const SAFETY = "Live trading is disabled. Acknowledgements do not enable live trading.";

  if (t.includes("can't start") || t.includes("cannot start") || t.includes("paper session")) {
    const exp = await explainBlockedAction("START_PAPER_SESSION");
    return { help_id: `help_${randomUUID()}`, topic, status: exp.highestSeverity, plainEnglishExplanation: exp.plainEnglishReasons.join(" "), reasonCodes: exp.technicalReasons, recommendedNextActions: exp.recommendedFixes, relatedPages: exp.links.map(l => l.href), safetyReminder: SAFETY, generatedAt: new Date().toISOString() };
  }
  if (t.includes("autopilot")) {
    const exp = await explainBlockedAction("START_AUTOPILOT");
    return { help_id: `help_${randomUUID()}`, topic, status: exp.highestSeverity, plainEnglishExplanation: exp.plainEnglishReasons.join(" "), reasonCodes: exp.technicalReasons, recommendedNextActions: exp.recommendedFixes, relatedPages: exp.links.map(l => l.href), safetyReminder: SAFETY, generatedAt: new Date().toISOString() };
  }
  if (t.includes("paper execution") || t.includes("rejected")) {
    const exp = await explainBlockedAction("OPEN_PAPER_TRADE");
    return { help_id: `help_${randomUUID()}`, topic, status: exp.highestSeverity, plainEnglishExplanation: exp.plainEnglishReasons.join(" "), reasonCodes: exp.technicalReasons, recommendedNextActions: exp.recommendedFixes, relatedPages: exp.links.map(l => l.href), safetyReminder: SAFETY, generatedAt: new Date().toISOString() };
  }
  if (t.includes("hold") || t.includes("aa")) {
    return { help_id: `help_${randomUUID()}`, topic, status: "INFO", plainEnglishExplanation: "AA returns HOLD when no high-quality setup is detected. This is the safe default.", reasonCodes: ["AA.confidence<threshold"], recommendedNextActions: ["Wait for a higher-confidence setup.", "Lower confidence threshold only if your strategy supports it."], relatedPages: ["/trading-cockpit", "/trader-coach"], safetyReminder: SAFETY, generatedAt: new Date().toISOString() };
  }
  if (t.includes("market data") || t.includes("degraded")) {
    return { help_id: `help_${randomUUID()}`, topic, status: "WARN", plainEnglishExplanation: "Market data is DEGRADED when DD reports unreliable feeds. Decisions become more cautious.", reasonCodes: ["DD.status=DEGRADED"], recommendedNextActions: ["Wait for the data feed to recover.", "Avoid running autopilot during a degraded feed."], relatedPages: ["/system-health"], safetyReminder: SAFETY, generatedAt: new Date().toISOString() };
  }
  if (t.includes("broker") || t.includes("read-only") || t.includes("readonly")) {
    return { help_id: `help_${randomUUID()}`, topic, status: "INFO", plainEnglishExplanation: "The broker connector is read-only. Live execution is disabled in this app.", reasonCodes: ["KK.brokerMode=READ_ONLY", "AA.canPlaceTrades=false"], recommendedNextActions: ["Use paper sessions to practice."], relatedPages: ["/broker-readonly", "/trading-cockpit"], safetyReminder: SAFETY, generatedAt: new Date().toISOString() };
  }
  if (t.includes("live") || t.includes("disabled")) {
    return { help_id: `help_${randomUUID()}`, topic, status: "BLOCK", plainEnglishExplanation: "This app is PAPER_ONLY. Live trading cannot be enabled from here, by design.", reasonCodes: ["safetyCore.canPlaceTrades=false (locked)"], recommendedNextActions: ["Practice in paper mode."], relatedPages: ["/trading-cockpit"], safetyReminder: SAFETY, generatedAt: new Date().toISOString() };
  }
  if (t.includes("safest") || t.includes("next step") || t.includes("what should")) {
    return { help_id: `help_${randomUUID()}`, topic, status: "INFO", plainEnglishExplanation: "The safest next step is whatever the cockpit's 'Recommended next step' card suggests. It already accounts for alerts, readiness, and risk.", reasonCodes: ["RR.nextBestAction"], recommendedNextActions: ["Open the Trading Cockpit and follow the recommended action."], relatedPages: ["/trading-cockpit"], safetyReminder: SAFETY, generatedAt: new Date().toISOString() };
  }
  return { help_id: `help_${randomUUID()}`, topic, status: "INFO", plainEnglishExplanation: "No matching explanation. Try one of: 'why can't I start a paper session', 'why is autopilot blocked', 'why is broker read-only', 'why is live trading disabled', 'what should I do next'.", reasonCodes: [], recommendedNextActions: ["Open the Help Center."], relatedPages: ["/help"], safetyReminder: SAFETY, generatedAt: new Date().toISOString() };
}
