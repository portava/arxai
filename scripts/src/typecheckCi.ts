import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

type TypecheckUnit = {
  name: string;
  command: string;
  args: string[];
  maxOldSpaceMb: number;
};

type TypecheckResult = {
  unit: TypecheckUnit;
  exitCode: number;
  durationMs: number;
};

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

const units: TypecheckUnit[] = [
  {
    name: "lib/* (composite, tsc --build)",
    command: "pnpm",
    args: ["run", "typecheck:libs"],
    maxOldSpaceMb: 3072,
  },
  {
    name: "@workspace/api-server",
    command: "pnpm",
    args: ["--filter", "@workspace/api-server", "run", "typecheck"],
    maxOldSpaceMb: 2560,
  },
  {
    name: "@workspace/scripts",
    command: "pnpm",
    args: ["--filter", "@workspace/scripts", "run", "typecheck"],
    maxOldSpaceMb: 2560,
  },
  {
    name: "@workspace/trading-dashboard",
    command: "pnpm",
    args: ["--filter", "@workspace/trading-dashboard", "run", "typecheck"],
    maxOldSpaceMb: 2560,
  },
];

function buildNodeOptions(maxOldSpaceMb: number): string {
  const inherited = (process.env.NODE_OPTIONS ?? "").trim();
  return `${inherited} --max-old-space-size=${maxOldSpaceMb}`.trim();
}

function runUnit(unit: TypecheckUnit): Promise<TypecheckResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    process.stdout.write(
      `\n──────── typecheck:ci → ${unit.name} (heap ${unit.maxOldSpaceMb}MB) ────────\n`,
    );
    const child = spawn(unit.command, unit.args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, NODE_OPTIONS: buildNodeOptions(unit.maxOldSpaceMb) },
    });
    child.on("error", (error) => {
      process.stderr.write(`Failed to start "${unit.name}": ${String(error)}\n`);
      resolve({ unit, exitCode: 1, durationMs: Date.now() - startedAt });
    });
    child.on("close", (code) => {
      resolve({ unit, exitCode: code ?? 1, durationMs: Date.now() - startedAt });
    });
  });
}

async function main(): Promise<void> {
  const results: TypecheckResult[] = [];
  for (const unit of units) {
    results.push(await runUnit(unit));
  }

  process.stdout.write(`\n════════════════ typecheck:ci summary ════════════════\n`);
  let failureCount = 0;
  for (const result of results) {
    const seconds = (result.durationMs / 1000).toFixed(1);
    if (result.exitCode === 0) {
      process.stdout.write(`  PASS            ${result.unit.name}  (${seconds}s)\n`);
    } else {
      failureCount += 1;
      process.stdout.write(
        `  FAIL exit ${String(result.exitCode).padEnd(3)} ${result.unit.name}  (${seconds}s)\n`,
      );
    }
  }
  process.stdout.write(`══════════════════════════════════════════════════════\n`);

  if (failureCount > 0) {
    process.stdout.write(
      `typecheck:ci FAILED — ${failureCount} of ${results.length} unit(s) reported type errors.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `typecheck:ci PASSED — all ${results.length} unit(s) typecheck clean.\n`,
  );
  process.exit(0);
}

void main();
