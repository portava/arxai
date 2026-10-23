// CI guard — the registration-key pepper must never be committed.
//
// REGISTRATION_KEY_PEPPER is the ONLY secret protecting registration-key
// hashes: a key's stored hash is sha256(normalizedKey + pepper). With the
// pepper in hand, anyone who can read the repo can brute-force the key space
// offline against the stored hashes, because registration keys are short and
// structured (ARX-XXXX-XXXX-XXXX). It was committed in plaintext in the
// git-tracked `.replit`.
//
// This guard fails the build if the pepper is assigned a literal value in any
// tracked config/source file. It must be supplied through the environment
// (Replit Secrets), which the code already expects — getRegistrationKeyPepper()
// reads process.env and fails closed when it is absent.
//
// Reading the variable, documenting it, or referencing its NAME is fine; only
// assigning it a literal is not.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ROOT, type CheckResult } from "./_lib.js";

const NAME = "REGISTRATION_KEY_PEPPER";

/** Files where a literal assignment would ship the secret. */
const SCANNED_EXTENSIONS = [".replit", ".toml", ".env", ".yaml", ".yml", ".json", ".sh"];

/** Test fixtures may set a throwaway pepper in-process; that is not a leak. */
const ALLOWED_PATH_PATTERNS = [/(^|\/)scripts\/src\/qa/, /__qa__/, /\.test\.ts$/];

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files"], {
    encoding: "utf8",
    cwd: ROOT,
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split("\n").filter(Boolean);
}

function isScanned(path: string): boolean {
  if (ALLOWED_PATH_PATTERNS.some((rx) => rx.test(path))) return false;
  return SCANNED_EXTENSIONS.some((ext) => path.endsWith(ext) || path.includes(ext + "."))
    || path.endsWith(".replit");
}

/**
 * A literal assignment: `NAME = "value"`, `NAME: "value"`, `NAME=value`.
 * Deliberately NOT matched: `process.env.NAME`, `env["NAME"]`, prose, and
 * commented-out lines.
 */
function literalAssignments(text: string): string[] {
  const hits: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") || line.startsWith("//") || line.startsWith("*")) continue;
    if (!line.includes(NAME)) continue;
    if (/process\.env|env\[|getenv|secrets?\b/i.test(line)) continue;
    if (new RegExp(`\\b${NAME}\\s*[:=]\\s*["'\`]?[^\\s"'\`]+`).test(line)) hits.push(line);
  }
  return hits;
}

export function checkNoCommittedPepper(): CheckResult {
  const notes: string[] = [];
  const violations: string[] = [];
  let scanned = 0;

  for (const file of trackedFiles()) {
    if (!isScanned(file)) continue;
    scanned++;
    let text: string;
    try {
      text = readFileSync(`${ROOT}/${file}`, "utf8");
    } catch {
      continue;
    }
    for (const line of literalAssignments(text)) {
      violations.push(`${file}: ${line.slice(0, 120)}`);
    }
  }

  notes.push(
    `Scanned ${scanned} tracked config file(s) for a literal ${NAME} assignment.`,
    "The pepper must come from the environment (Replit Secrets) only — the code",
    "reads process.env and fails closed when it is absent.",
  );
  return { name: "no-committed-pepper", ok: violations.length === 0, violations, notes };
}
