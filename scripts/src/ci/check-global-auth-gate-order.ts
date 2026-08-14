import { read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

// Global auth-gate order guard.
//
// THE FOOTGUN THIS CATCHES
// ------------------------
// routes/index.ts mounts TWO middlewares globally (no path prefix) that run on
// EVERY /api/* request, in a deliberate order:
//
//   router.use(requireAuthOrPublic);     // 401 logged-out callers (allowlist aside)
//   router.use(enforceProductRoleAccess); // single-active-role enforcement
//
// The product-role gate is documented to run "right after the auth gate so it
// sees a populated req.authUser". If someone swaps their order, drops one,
// duplicates one, or wedges another global `router.use(<bareMiddleware>)`
// between them, a whole class of users can be silently locked out (403/401)
// with NO other CI signal — the sibling router-level-access-guard-leak guard
// deliberately does NOT track these two by design.
//
// This guard asserts the global gate in index.ts keeps its expected shape:
//   (a) requireAuthOrPublic is mounted globally exactly once,
//   (b) enforceProductRoleAccess is mounted globally exactly once,
//   (c) requireAuthOrPublic appears BEFORE enforceProductRoleAccess.
//
// Static source scan (no app boot). Line comments are stripped first so the
// doc-comment examples above can never trip the scan, and the detector runs a
// synthetic self-check so silent regex drift fails the build.

const API = join(ROOT, "artifacts/api-server/src");
const INDEX_FILE = join(API, "routes/index.ts");

const AUTH_GATE = "requireAuthOrPublic";
const ROLE_GATE = "enforceProductRoleAccess";

function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((l) => {
      const i = l.indexOf("//");
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join("\n");
}

// Record, for each global `router.use(<bareIdentifier>)` mount (no leading path
// string), the identifier and the source offset where it appears. Path-prefixed
// mounts (`router.use("/x", r)`) and multi-arg mounts are ignored — the global
// gate is always a single bare-identifier mount.
function globalMountOrder(src: string): Array<{ ident: string; at: number }> {
  const order: Array<{ ident: string; at: number }> = [];
  const useRe = /router\.use\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(src))) {
    const args = m[1].trim();
    if (!args) continue;
    if (/^["'`]/.test(args)) continue; // path-prefixed — not a global gate mount
    if (!/^\w+$/.test(args)) continue; // not a bare identifier (e.g. factory call)
    order.push({ ident: args, at: m.index });
  }
  return order;
}

// Pure detector: given index.ts source, assert the global gate keeps its
// expected order/shape. Returns a violation string per problem found.
export function detectGlobalAuthGateOrderViolations(indexSrc: string): string[] {
  const violations: string[] = [];
  const mounts = globalMountOrder(stripLineComments(indexSrc));

  const authMounts = mounts.filter((m) => m.ident === AUTH_GATE);
  const roleMounts = mounts.filter((m) => m.ident === ROLE_GATE);

  if (authMounts.length === 0) {
    violations.push(
      `routes/index.ts → global auth gate "${AUTH_GATE}" is not mounted (router.use(${AUTH_GATE})). ` +
        `This is the deny-by-default per-user auth gate; without it logged-out callers reach protected routes.`,
    );
  } else if (authMounts.length > 1) {
    violations.push(
      `routes/index.ts → global auth gate "${AUTH_GATE}" is mounted ${authMounts.length} times; expected exactly once.`,
    );
  }

  if (roleMounts.length === 0) {
    violations.push(
      `routes/index.ts → product-role gate "${ROLE_GATE}" is not mounted (router.use(${ROLE_GATE})). ` +
        `This is the central single-active-role enforcement gate; without it role access is unenforced.`,
    );
  } else if (roleMounts.length > 1) {
    violations.push(
      `routes/index.ts → product-role gate "${ROLE_GATE}" is mounted ${roleMounts.length} times; expected exactly once.`,
    );
  }

  if (authMounts.length >= 1 && roleMounts.length >= 1) {
    const firstAuth = authMounts[0].at;
    const firstRole = roleMounts[0].at;
    if (firstAuth > firstRole) {
      violations.push(
        `routes/index.ts → "${ROLE_GATE}" is mounted BEFORE "${AUTH_GATE}". ` +
          `The product-role gate must run AFTER the auth gate so it sees a populated req.authUser. ` +
          `Mount router.use(${AUTH_GATE}) first, then router.use(${ROLE_GATE}).`,
      );
    }
  }

  return violations;
}

// Synthetic self-check: the detector MUST pass on the correct ordering and MUST
// flag each failure mode (missing, duplicated, swapped). If this drifts, the
// regex silently stopped catching the footgun — fail the build loudly.
function selfCheck(): string[] {
  const problems: string[] = [];
  const wrap = (lines: string[]): string => lines.join("\n");

  const good = wrap([
    `router.use(${AUTH_GATE});`,
    `router.use(${ROLE_GATE});`,
    "router.use(healthRouter);",
  ]);
  if (detectGlobalAuthGateOrderViolations(good).length !== 0) {
    problems.push("self-check: detector wrongly flagged a correctly-ordered global gate");
  }

  const swapped = wrap([`router.use(${ROLE_GATE});`, `router.use(${AUTH_GATE});`]);
  if (!detectGlobalAuthGateOrderViolations(swapped).some((v) => v.includes("BEFORE"))) {
    problems.push("self-check: detector FAILED to flag a swapped global gate order");
  }

  const missingAuth = wrap([`router.use(${ROLE_GATE});`]);
  if (!detectGlobalAuthGateOrderViolations(missingAuth).some((v) => v.includes(AUTH_GATE) && v.includes("not mounted"))) {
    problems.push("self-check: detector FAILED to flag a missing auth gate");
  }

  const missingRole = wrap([`router.use(${AUTH_GATE});`]);
  if (!detectGlobalAuthGateOrderViolations(missingRole).some((v) => v.includes(ROLE_GATE) && v.includes("not mounted"))) {
    problems.push("self-check: detector FAILED to flag a missing product-role gate");
  }

  const dupAuth = wrap([`router.use(${AUTH_GATE});`, `router.use(${AUTH_GATE});`, `router.use(${ROLE_GATE});`]);
  if (!detectGlobalAuthGateOrderViolations(dupAuth).some((v) => v.includes(AUTH_GATE) && v.includes("times"))) {
    problems.push("self-check: detector FAILED to flag a duplicated auth gate");
  }

  const dupRole = wrap([`router.use(${AUTH_GATE});`, `router.use(${ROLE_GATE});`, `router.use(${ROLE_GATE});`]);
  if (!detectGlobalAuthGateOrderViolations(dupRole).some((v) => v.includes(ROLE_GATE) && v.includes("times"))) {
    problems.push("self-check: detector FAILED to flag a duplicated product-role gate");
  }

  return problems;
}

export function checkGlobalAuthGateOrder(): CheckResult {
  const violations: string[] = [];

  let indexSrc = "";
  try {
    indexSrc = read(INDEX_FILE);
  } catch {
    violations.push(`${rel(INDEX_FILE)} → file missing`);
  }

  if (indexSrc) {
    violations.push(...detectGlobalAuthGateOrderViolations(indexSrc));
  }

  violations.push(...selfCheck());

  return {
    name: "global-auth-gate-order",
    ok: violations.length === 0,
    violations,
    notes: [
      `routes/index.ts must mount "${AUTH_GATE}" then "${ROLE_GATE}" globally, each exactly once, in that order.`,
      "The product-role gate runs after the auth gate so it sees a populated req.authUser.",
      "A swapped/missing/duplicated global gate can silently lock out a whole class of users with no other CI signal.",
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkGlobalAuthGateOrder();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
