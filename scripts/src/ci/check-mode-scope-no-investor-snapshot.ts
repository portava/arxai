// CI guard — mode-scope-no-investor-snapshot
//
// Guards against the account-shell ↔ mode-resolver infinite async loop
// (Task #443). The closed mutual-recursion triangle is:
//
//   getUserModeScope → computeAccountShell → buildInvestorLiveBalanceSnapshot
//                    ↑__________________________________________|
//
// Every hop is `async`/`await`, so the cycle does NOT overflow the stack or
// throw — getUserModeScope's try/catch → PAPER fallback never fires; it just
// recurses forever doing DB queries and HANGS with no error and no timeout.
// That silently breaks /api/me/account, the balance SSE stream, Ruby, and the
// risk engine. It was fixed by having the resolver call
// `computeAccountShell(userId, { skipInvestorSnapshot: true })`, which makes
// the shell return a null investor snapshot (the resolver only reads
// tradingMode/tradingStatus/notes, never `live`).
//
// Nothing else prevents a future edit from silently re-introducing the hang.
// This guard fails the build if:
//
//  1. getUserModeScope.ts calls `computeAccountShell(` WITHOUT passing
//     `skipInvestorSnapshot: true`.
//  2. getUserModeScope.ts references `buildInvestorLiveBalanceSnapshot` at all
//     (the resolver must never build the investor snapshot directly either).
//  3. meAccountShell.ts no longer honours the `skipInvestorSnapshot` flag —
//     i.e. the `buildInvestorLiveBalanceSnapshot(` call is not gated behind
//     `opts.skipInvestorSnapshot ? null : …`, or a second UNGATED call exists.
//     Without this, passing the skip flag from the resolver would be a no-op
//     and the cycle would return.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reportResult, type CheckResult } from "./_lib.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
function read(p: string): string {
  return readFileSync(join(ROOT, p), "utf-8");
}

// Remove line and block comments so documentation that mentions the forbidden
// patterns does not trip the guard.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

const RESOLVER = "artifacts/api-server/src/lib/modeScope/getUserModeScope.ts";
const SHELL = "artifacts/api-server/src/routes/meAccountShell.ts";

export function checkModeScopeNoInvestorSnapshot(): CheckResult {
  const violations: string[] = [];

  // ---- Resolver side ------------------------------------------------------
  const resolverSrc = read(RESOLVER);
  const resolverCode = stripComments(resolverSrc);

  // (1) Every computeAccountShell( call in the resolver must pass
  //     skipInvestorSnapshot: true. We inspect the call argument window up to
  //     the matching close of the statement.
  const shellCallRe = /computeAccountShell\s*\(/g;
  let m: RegExpExecArray | null;
  let sawShellCall = false;
  while ((m = shellCallRe.exec(resolverCode)) !== null) {
    sawShellCall = true;
    // Grab a generous window after the call opener to inspect its arguments.
    const window = resolverCode.slice(m.index, m.index + 240);
    if (!/skipInvestorSnapshot\s*:\s*true/.test(window)) {
      violations.push(
        `${RESOLVER} — computeAccountShell(...) called WITHOUT ` +
          "`skipInvestorSnapshot: true`. This re-opens the " +
          "getUserModeScope → computeAccountShell → buildInvestorLiveBalanceSnapshot " +
          "infinite async loop that silently hangs the account/balance surfaces.",
      );
    }
  }
  if (!sawShellCall) {
    violations.push(
      `${RESOLVER} — expected a computeAccountShell(...) call passing ` +
        "`skipInvestorSnapshot: true`; none found (was the resolver refactored?).",
    );
  }

  // (2) The resolver must never build the investor snapshot itself.
  if (/buildInvestorLiveBalanceSnapshot/.test(resolverCode)) {
    violations.push(
      `${RESOLVER} — references buildInvestorLiveBalanceSnapshot. The mode ` +
        "resolver must NEVER build the investor balance snapshot (directly or " +
        "via import) — that is the exact hop that closes the infinite loop.",
    );
  }

  // ---- Shell side ---------------------------------------------------------
  // (3) computeAccountShell must still honour the skip flag, otherwise passing
  //     it from the resolver is a no-op and the cycle returns.
  const shellSrc = read(SHELL);
  const shellCode = stripComments(shellSrc);

  const guardedRe =
    /skipInvestorSnapshot[\s\S]{0,40}\?\s*null[\s\S]{0,80}buildInvestorLiveBalanceSnapshot\s*\(/;
  if (!guardedRe.test(shellCode)) {
    violations.push(
      `${SHELL} — the buildInvestorLiveBalanceSnapshot(...) call is no longer ` +
        "gated behind `opts.skipInvestorSnapshot ? null : …`. The skip flag " +
        "MUST short-circuit the snapshot build, or the resolver's flag is a " +
        "no-op and the infinite loop returns.",
    );
  }

  // Any additional, ungated build call defeats the gate. There must be exactly
  // one call site (the gated one).
  const callCount = (shellCode.match(/buildInvestorLiveBalanceSnapshot\s*\(/g) ?? [])
    .length;
  if (callCount > 1) {
    violations.push(
      `${SHELL} — found ${callCount} buildInvestorLiveBalanceSnapshot(...) call ` +
        "sites; expected exactly one (the skip-flag-gated call). An extra, " +
        "ungated build re-opens the loop.",
    );
  }

  return {
    name: "mode-scope-no-investor-snapshot",
    ok: violations.length === 0,
    violations,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkModeScopeNoInvestorSnapshot();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
