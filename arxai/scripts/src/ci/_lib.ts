import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../../..");

export type CheckResult = {
  name: string;
  ok: boolean;
  violations: string[];
  notes?: string[];
};

export function walk(
  dir: string,
  opts: { exts?: string[]; skip?: (p: string) => boolean } = {},
): string[] {
  const exts = opts.exts ?? [".ts", ".tsx", ".mts", ".cts"];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(d, name);
      if (
        name === "node_modules" ||
        name === "dist" ||
        name === "build" ||
        name === ".git" ||
        name === "generated" ||
        name === ".replit-artifact" ||
        name.startsWith(".turbo")
      ) {
        continue;
      }
      if (opts.skip && opts.skip(p)) continue;
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) stack.push(p);
      else if (exts.some((e) => name.endsWith(e))) out.push(p);
    }
  }
  return out;
}

export function read(p: string): string {
  return readFileSync(p, "utf8");
}

export function rel(p: string): string {
  return relative(ROOT, p);
}

export function reportResult(r: CheckResult): void {
  const status = r.ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`[${status}] ${r.name}${r.violations.length ? ` (${r.violations.length} violation${r.violations.length === 1 ? "" : "s"})` : ""}`);
  for (const v of r.violations) {
    // eslint-disable-next-line no-console
    console.log(`  - ${v}`);
  }
  if (r.notes) {
    for (const n of r.notes) {
      // eslint-disable-next-line no-console
      console.log(`  · ${n}`);
    }
  }
}
