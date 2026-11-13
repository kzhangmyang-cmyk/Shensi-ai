import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as runtime from './runtime-env.js';

test('embedded books require only a trusted local pack, never a central server',()=>{
  const env={SHENSI_REFERENCE_MODE:'embedded',SHENSI_REFERENCE_PACK:'/app/resources/system-reference/books.json.gz',SHENSI_REFERENCE_PACK_SHA256:'a'.repeat(64)};
  assert.deepEqual(runtime.readReferenceRuntime(env),{mode:'embedded',packPath:env.SHENSI_REFERENCE_PACK,packHash:env.SHENSI_REFERENCE_PACK_SHA256});
  for(const override of [{SHENSI_REFERENCE_PACK:'relative'},{SHENSI_REFERENCE_PACK_SHA256:''},{SHENSI_REFERENCE_ORIGIN:'https://wrong.test'}])
    assert.throws(()=>runtime.readReferenceRuntime({...env,...override}),/reference_configuration_invalid/);
});

test('system reference runtime defaults disabled, strictly pins central/client and rejects incomplete or ambiguous config',()=>{
  const read=(runtime as unknown as {readReferenceRuntime?:(env:NodeJS.ProcessEnv)=>unknown}).readReferenceRuntime;
  assert.equal(typeof read,'function','trusted reference runtime parser required');if(!read)return;
  assert.deepEqual(read({}),{mode:'disabled'});
  const env={SHENSI_REFERENCE_MODE:'client',SHENSI_REFERENCE_ORIGIN:'https://library.example.test',SHENSI_REFERENCE_ISSUER:'https://library.example.test',SHENSI_REFERENCE_BACKEND_INSTANCE_ID:'installation'};
  assert.deepEqual(read(env),{mode:'client',origin:'https://library.example.test',issuer:'https://library.example.test',backendInstanceId:'installation'});
  assert.throws(()=>read({...env,SHENSI_REFERENCE_MODE:'central'}),/reference_configuration_invalid/u);
  const corpusId='f8f30392-04fa-45be-8465-337e9073e34e';
  assert.deepEqual(read({...env,SHENSI_REFERENCE_MODE:'central',SHENSI_REFERENCE_CORPUS_ID:corpusId}),{mode:'central',origin:'https://library.example.test',issuer:'https://library.example.test',backendInstanceId:'installation',corpusId});
  for(const mode of ['disabled','client'])assert.throws(()=>read({...env,SHENSI_REFERENCE_MODE:mode,SHENSI_REFERENCE_CORPUS_ID:corpusId}),/reference_configuration_invalid/u);
  assert.throws(()=>read({...env,SHENSI_REFERENCE_MODE:'central',SHENSI_REFERENCE_CORPUS_ID:'private-workspace'}),/reference_configuration_invalid/u);
  for(const override of [{SHENSI_REFERENCE_MODE:'remote'},{SHENSI_REFERENCE_ORIGIN:'http://127.0.0.1:1234'},{SHENSI_REFERENCE_ORIGIN:'https://library.example.test/path'},{SHENSI_REFERENCE_ISSUER:'https://other.example.test'},{SHENSI_REFERENCE_BACKEND_INSTANCE_ID:''},{SHENSI_REFERENCE_MODE:'disabled'}]) assert.throws(()=>read({...env,...override}),/reference_configuration_invalid/u);
});

test("explicit fresh-runtime environment does not inherit repository dotenv configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-local-env-"));
  try {
    await mkdir(join(root, "backend", "src"), { recursive: true });
    const module = join(root, "backend", "src", "runtime-env.mjs");
    await writeFile(module, await readFile(new URL("./runtime-env.ts", import.meta.url)));
    await writeFile(join(root, ".env"), "SHENSI_ENV_PROBE=old-runtime\n");
    const run = (skip: string) => execFileSync(process.execPath,
      ["--input-type=module", "-e", "import {loadLocalEnv} from './backend/src/runtime-env.mjs'; loadLocalEnv(); process.stdout.write(process.env.SHENSI_ENV_PROBE ?? 'empty');"],
      { cwd: root, env: { SHENSI_SKIP_LOCAL_ENV: skip }, encoding: "utf8" });
    assert.equal(run("true"), "empty");
    assert.equal(run("false"), "old-runtime");
  } finally { await rm(root, { recursive: true, force: true }); }
});
