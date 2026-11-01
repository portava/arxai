import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkRiskyWordingFrontend } from "./check-risky-wording-frontend.js";
import { checkNoInternalNamesUserUi, findInternalDisplayLeaks, findAssistantNameLeaksInSource } from "./check-no-internal-names-user-ui.js";
import { checkInvestorNoGuaranteedReturn } from "./check-investor-no-guaranteed-return.js";
import { readWordingSources, parseWordingSource, copyFragments } from "./wording-source.js";

const root = mkdtempSync(join(tmpdir(), "arx-wording-guard-"));
const previous = process.cwd();
let assertions = 0;
function check(ok: unknown, message: string) { assert.ok(ok, message); assertions++; }
function write(path: string, source: string) { const full = join(root, path); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, source); }
const frontend = "artifacts/trading-dashboard/src";
const checks = [checkRiskyWordingFrontend, checkNoInternalNamesUserUi, checkInvestorNoGuaranteedReturn];
try {
  for (const path of [`${frontend}/pages/investor.tsx`, `${frontend}/pages/admin/investors.tsx`, "artifacts/api-server/src/routes/meInvestor.ts", "artifacts/api-server/src/routes/adminInvestors.ts", "artifacts/api-server/src/lib/investor/investorService.ts", "lib/domain/src/empty.ts"]) write(path, "export {};\n");
  mkdirSync(join(root, "scripts"));
  write(`${frontend}/pages/sample.tsx`, `// guaranteed profit, Ruby, JSON.stringify(x)
    const internal = { Ruby: true }; type Ruby = string;
    const regex = /Ruby/; const pattern = /https?:\\/\\//;
    export const Panel = () => <><p>Deposit money</p><p>Talk to Ruby</p><code>/api/private</code><div>{JSON.stringify({})}</div><p>Type <strong>EXECUTE LIVE SHARED</strong> to continue</p></>;`);
  write(`${frontend}/pages/investor.tsx`, 'export const Panel = () => <p>We promise guaranteed returns.</p>;');
  process.chdir(root); const fromRoot = checks.map(fn => fn({ root }));
  process.chdir(join(root, "scripts")); const fromScripts = checks.map(fn => fn({ root }));
  check(JSON.stringify(fromRoot) === JSON.stringify(fromScripts), "same exact findings and coverage from both working directories");
  check(fromRoot.every(r => !r.ok && r.violations.length), "all three reject actual product text");
  check(fromRoot[1]!.violations.some(v => v.includes("code-tag-api-path")), "actual code API leak");
  check(fromRoot[1]!.violations.some(v => v.includes("json-stringify-in-jsx")), "actual JSX JSON leak");
  check(fromRoot[1]!.violations.some(v => v.includes("typed-phrase-prompt")), "typed phrase spans JSX markup");
  for (const cwd of [root, join(root, "scripts")]) for (const fn of checks) {
    process.chdir(cwd);
    const missingTool = fn({ root, rgBinary: join(root, "missing-rg") });
    check(!missingTool.ok && missingTool.violations.some(v => v.includes("scan-coverage")), `${fn.name}: missing tool fails`);
    const missingPath = fn({ root: join(root, "missing-root") });
    check(!missingPath.ok && missingPath.violations.some(v => v.includes("scan-coverage")), `${fn.name}: missing path fails`);
  }
  write(`${frontend}/pages/sample.tsx`, `// guaranteed profit Ruby
    /* <code>/api/private</code> {JSON.stringify(x)} */
    const Ruby = 1; const pattern = /Ruby/;
    logger.warn("Ruby internal diagnostic");
    export const Panel = () => <p>Market data</p>;`);
  write(`${frontend}/pages/investor.tsx`, '// guaranteed returns\nexport const Panel = () => <p>Recorded performance only.</p>;');
  write(`${frontend}/pages/sample.test.tsx`, 'export const Test = () => <p>Deposit money, Ruby, guaranteed profit</p>;');
  write(`${frontend}/pages/__qa__/sample.tsx`, 'export const Qa = () => <code>/api/private</code>;');
  check(checks.every(fn => fn({ root }).ok), "comments/tests/type syntax/logging are not product copy");
  write(`${frontend}/pages/sample.tsx`, 'export const Panel = () => <Card body="Deposit money" aria-label="Talk to Ruby" />;');
  check(!checkRiskyWordingFrontend({ root }).ok, "custom component copy props remain scanned");
  check(!checkNoInternalNamesUserUi({ root }).ok, "accessible copy remains scanned");
  write(`${frontend}/pages/sample.tsx`, 'const x = `Hello ${1 /* Ruby */} Ruby`;');
  check(findAssistantNameLeaksInSource("sample.tsx", 'const x = `Hello ${1 /* Ruby */} Ruby`;').length === 1, "template expression comments excluded but literal copy retained");
  check(findAssistantNameLeaksInSource("sample.tsx", 'const x = template.replace(/Ruby/g, name); const other = "Ruby";').length === 1, "name swap cannot waive an unrelated same-line copy leak");
  write(`${frontend}/pages/sample.tsx`, "export const broken = <p>;");
  check(!checkRiskyWordingFrontend({ root }).ok && checkRiskyWordingFrontend({ root }).violations.some(v => v.includes("scan-coverage")), "parse failures cannot certify clean copy");
  mkdirSync(join(root, "empty"));
  assert.throws(() => readWordingSources(["empty"], { root })); assertions++;
  write("tests-only/only.test.ts", "export {}; ");
  assert.throws(() => readWordingSources(["tests-only"], { root }), /No product source files/); assertions++;
  const fragments = copyFragments(parseWordingSource("sample.tsx", 'import { Ruby } from "Ruby"; type T = "Ruby"; const { Ruby: internal } = value; const a = <div data-testid="Ruby" title="Ruby" />;'));
  check(fragments.filter(f => f.text === "Ruby").length === 1, "only the title copy counts, not imports/types/test metadata");
  const displayedJson = parseWordingSource("sample.tsx", '<Card title={JSON.stringify(secret)} aria-label={JSON.stringify(secret)} body={JSON.stringify(secret)} data={JSON.stringify(secret)} />');
  check(findInternalDisplayLeaks(displayedJson).filter(v => v.includes("json-stringify-in-jsx")).length === 4, "potentially displayed attribute expressions cannot hide raw JSON");
  const handlerJson = parseWordingSource("sample.tsx", '<button onClick={() => console.log(JSON.stringify(secret))} data-testid={JSON.stringify(testId)}>Open</button>');
  check(findInternalDisplayLeaks(handlerJson).length === 0, "event-handler diagnostics and test metadata are not rendered JSON");
  console.log(JSON.stringify({ assertions, cwdParity: true, missingToolsAndPathsFail: true, productNegativeCases: true }));
} finally { process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
