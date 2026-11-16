import { execFileSync } from "node:child_process";

/** Captured from the source checkout at build time, never from runtime env. */
export function captureBuildIdentity(cwd) {
  try {
    const git = args => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    // Git walks upward: an archive inside an unrelated repository must not
    // borrow that parent's clean revision as its own source provenance.
    git(["ls-files", "--error-unmatch", "--", "build.mjs", "src/index.ts"]);
    const revision = git(["rev-parse", "HEAD"]);
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid revision");
    const dirty = git(["status", "--porcelain", "--untracked-files=normal"]) !== "";
    return { revision, sourceState: dirty ? "modified" : "clean" };
  } catch {
    // Source archives without git must not claim a verified source revision.
    return { revision: null, sourceState: "unknown" };
  }
}
