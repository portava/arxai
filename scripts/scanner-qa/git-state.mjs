// Git state of a checkout, shared by prod-server.mjs (recorded in a bundle's build info)
// and measure.mjs (compared with the build info of the bundle it measures), so both
// compute the same dirtyHash.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

// HEAD, a dirty flag and dirtyHash (SHA-256 of the tracked diff plus every untracked,
// non-ignored file). If any git call fails (no git, "dubious ownership" for another user),
// dirty is "unknown" and dirtyHash null rather than a clean-looking false.
export const gitState = async dir => {
  const errors = [];
  const git = (...a) => {
    try { return execFileSync("git", a, { cwd: dir, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }); }
    catch (error) { errors.push(`git ${a[0]}: ${(error.stderr?.toString() || error.message).trim().split("\n")[0]}`); return null; }
  };
  const head = git("rev-parse", "HEAD")?.toString().trim() || null;
  const status = git("status", "--porcelain=v1", "-z", "--untracked-files=all")?.toString();
  let dirtyHash = null;
  if (status) {
    const diff = git("diff", "HEAD", "--binary");
    const others = git("ls-files", "-z", "--others", "--exclude-standard")?.toString();
    if (diff != null && others != null) {
      const hash = createHash("sha256").update(diff);
      for (const file of others.split("\0").filter(Boolean).sort())
        hash.update(`\0${file}\0`).update(await readFile(path.join(dir, file)).catch(error => `\0unreadable:${error.code}\0`));
      dirtyHash = hash.digest("hex");
    }
  }
  if (errors.length) return { head, dirty: "unknown", dirtyHash: null, error: errors.join("; ") };
  return { head, dirty: Boolean(status), dirtyHash };
};
