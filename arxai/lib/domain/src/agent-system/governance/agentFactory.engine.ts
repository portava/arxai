// Agent Ecosystem — Layer 3 Governed Agent Factory (PURE validator).
//
// PURPOSE
//   Validate a request to create a NEW agent RECORD (never application source code).
//   The Factory exists so a real, repeated task gap can be filled by a governed new
//   agent — but only under strict gates. This module is the PURE validator: it
//   checks the request, rejects unsafe / duplicate / under-specified requests, and
//   returns a NORMALIZED spec that is forced to be born in Shadow Mode at 0%
//   authority with no live influence. Persistence + admin approval live in the
//   api-server layer; nothing here touches I/O or a DB.
//
// SAFETY / SCOPE (inviolable):
//   - A created agent is ALWAYS born SHADOW, authorityWeight 0, liveInfluenceAllowed
//     false. The Factory cannot mint an agent with any authority or any live
//     influence — earned authority only comes later from the Promotion Board.
//   - A request whose permissions include ANY universally-forbidden action
//     (place_trade, modify_trade, close_trade, mutate_connections,
//     read_other_user_data, bypass_safety_gate) is REJECTED outright.
//   - PURE: deterministic, no I/O, no clock, no DB.

import { UNIVERSAL_FORBIDDEN } from "../coreAgents";

export interface AgentCreationRequestInput {
  proposedName: string;
  proposedDepartment: string;
  purpose: string;
  reasonNeeded: string;
  workflowGap: string;
  allowedInputs: string[];
  allowedOutputs: string[];
  permissions: string[];
  failureConditions: string[];
  scorecard: string[];
  testingRequirements: string[];
  activationRequirements: string[];
  parentAgentKey?: string | null;
}

/** Minimal view of an existing agent used for duplicate detection. */
export interface ExistingAgentLite {
  agentKey: string;
  name: string;
  department: string;
}

export interface NormalizedAgentCreationSpec {
  proposedName: string;
  proposedDepartment: string;
  purpose: string;
  reasonNeeded: string;
  workflowGap: string;
  allowedInputs: string[];
  allowedOutputs: string[];
  permissions: string[];
  failureConditions: string[];
  scorecard: string[];
  testingRequirements: string[];
  activationRequirements: string[];
  parentAgentKey: string | null;
  // Forced governance defaults — NOT caller-controllable.
  startingStatus: "SHADOW";
  startingMode: "SHADOW";
  authorityWeight: 0;
  liveInfluenceAllowed: false;
  canCreateAgents: false;
  creationRightLevel: "NONE";
}

export interface AgentCreationValidation {
  valid: boolean;
  errors: string[];
  /** Present only when valid — safe to persist as a PROPOSED record. */
  normalized?: NormalizedAgentCreationSpec;
}

const REQUIRED_TEXT_FIELDS: (keyof AgentCreationRequestInput)[] = [
  "proposedName",
  "proposedDepartment",
  "purpose",
  "reasonNeeded",
  "workflowGap",
];

const REQUIRED_LIST_FIELDS: (keyof AgentCreationRequestInput)[] = [
  "allowedInputs",
  "allowedOutputs",
  "failureConditions",
  "scorecard",
  "testingRequirements",
  "activationRequirements",
];

const FORBIDDEN = new Set<string>(UNIVERSAL_FORBIDDEN);

function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter((x) => x.length > 0);
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Validate + normalize a creation request. Returns valid:false with a list of
 * neutral error codes when anything is missing, duplicated, or unsafe.
 */
export function validateAgentCreationRequest(
  req: AgentCreationRequestInput,
  existingAgents: readonly ExistingAgentLite[] = [],
): AgentCreationValidation {
  const errors: string[] = [];

  for (const f of REQUIRED_TEXT_FIELDS) {
    const v = req[f];
    if (typeof v !== "string" || v.trim().length < 3) {
      errors.push(`missing_or_short_field:${f}`);
    }
  }

  for (const f of REQUIRED_LIST_FIELDS) {
    if (cleanList(req[f] as unknown).length === 0) {
      errors.push(`missing_list_field:${f}`);
    }
  }

  // Permissions: must be present and must NOT request any forbidden action.
  const permissions = cleanList(req.permissions);
  if (permissions.length === 0) {
    errors.push("missing_list_field:permissions");
  }
  const requestedForbidden = permissions.filter((p) => FORBIDDEN.has(norm(p).replace(/ /g, "_")));
  for (const bad of requestedForbidden) {
    errors.push(`forbidden_permission:${norm(bad).replace(/ /g, "_")}`);
  }

  // Duplicate detection: same name (case-insensitive) as an existing agent.
  const proposedName = (req.proposedName ?? "").trim();
  if (proposedName) {
    const dupe = existingAgents.find((a) => norm(a.name) === norm(proposedName));
    if (dupe) errors.push(`duplicate_agent_name:${dupe.agentKey}`);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const normalized: NormalizedAgentCreationSpec = {
    proposedName,
    proposedDepartment: req.proposedDepartment.trim(),
    purpose: req.purpose.trim(),
    reasonNeeded: req.reasonNeeded.trim(),
    workflowGap: req.workflowGap.trim(),
    allowedInputs: cleanList(req.allowedInputs),
    allowedOutputs: cleanList(req.allowedOutputs),
    permissions,
    failureConditions: cleanList(req.failureConditions),
    scorecard: cleanList(req.scorecard),
    testingRequirements: cleanList(req.testingRequirements),
    activationRequirements: cleanList(req.activationRequirements),
    parentAgentKey: req.parentAgentKey ? req.parentAgentKey.trim() : null,
    // Forced, non-negotiable governance defaults:
    startingStatus: "SHADOW",
    startingMode: "SHADOW",
    authorityWeight: 0,
    liveInfluenceAllowed: false,
    canCreateAgents: false,
    creationRightLevel: "NONE",
  };

  return { valid: true, errors: [], normalized };
}
