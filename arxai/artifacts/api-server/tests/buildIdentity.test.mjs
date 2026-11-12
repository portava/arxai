import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { captureBuildIdentity } from '../buildIdentity.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'arx-build-identity-'));
  const git = (...args) => execFileSync('git', args, {cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init'); git('config','user.name','ARX Test'); git('config','user.email','arx-test@example.invalid');
  writeFileSync(join(dir,'source.txt'),'original'); git('add','.'); git('-c','commit.gpgsign=false','commit','-m','fixture');
  return {dir,git};
}
test('build identity distinguishes committed, unstaged, staged and untracked source', () => {
  const {dir,git}=fixture();
  try {
    const revision=git('rev-parse','HEAD');
    assert.deepEqual(captureBuildIdentity(dir),{revision,sourceState:'clean'});
    writeFileSync(join(dir,'source.txt'),'changed');
    assert.deepEqual(captureBuildIdentity(dir),{revision,sourceState:'modified'});
    git('add','.');
    assert.equal(captureBuildIdentity(dir).sourceState,'modified');
    git('-c','commit.gpgsign=false','commit','-m','change');
    assert.equal(captureBuildIdentity(dir).sourceState,'clean');
    assert.notEqual(captureBuildIdentity(dir).revision,revision);
    writeFileSync(join(dir,'untracked.txt'),'new code');
    assert.equal(captureBuildIdentity(dir).sourceState,'modified');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('source archive does not invent a clean source revision',()=>{
  const dir=mkdtempSync(join(tmpdir(),'arx-source-archive-'));
  try {assert.deepEqual(captureBuildIdentity(dir),{revision:null,sourceState:'unknown'});}
  finally {rmSync(dir,{recursive:true,force:true});}
});
test('real bundled identity survives source changes and cannot be replaced by runtime environment',async()=>{
  const {dir}=fixture();
  try {
    const identity=captureBuildIdentity(dir);
    const outfile=join(dir,'output.mjs');
    await build({entryPoints:[resolve('src/lib/startup/buildIdentity.ts')],bundle:true,platform:'node',format:'esm',outfile,define:{__ARX_BUILD_IDENTITY__:JSON.stringify(identity)}});
    writeFileSync(join(dir,'source.txt'),'after build');
    const before=process.env.APP_VERSION;
    process.env.APP_VERSION='runtime-unrelated-revision';
    try {
      const {getBuildIdentity}=await import(pathToFileURL(outfile).href);
      assert.deepEqual(getBuildIdentity(),identity);
      const changed=getBuildIdentity();changed.revision='forged';
      assert.deepEqual(getBuildIdentity(),identity);
    } finally {if(before===undefined)delete process.env.APP_VERSION;else process.env.APP_VERSION=before;}
  } finally {rmSync(dir,{recursive:true,force:true});}
});
