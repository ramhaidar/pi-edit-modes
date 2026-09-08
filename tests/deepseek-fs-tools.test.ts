import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sourcePromise = readFile(new URL("../src/tools/deepseek/fs-tools.ts", import.meta.url), "utf8");

function block(source: string, functionName: string, nextFunctionName: string): string {
  const start = source.indexOf(`function ${functionName}`);
  const end = source.indexOf(`function ${nextFunctionName}`, start + 1);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

test("DeepSeek write keeps Harness fields authoritative and prepares Pi compatibility aliases", async () => {
  const source = await sourcePromise;
  const write = block(source, "registerDeepSeekWrite", "registerDeepSeekEdit");
  assert.match(write, /file_path:\s*Type\.String/);
  assert.match(write, /content:\s*Type\.String/);
  assert.match(write, /path:\s*Type\.Optional\(Type\.String/);
  assert.match(write, /prepareArguments:\s*prepareDeepSeekWriteArgsForPi/);
});

test("DeepSeek edit keeps Harness literal fields authoritative and prepares Pi compatibility aliases", async () => {
  const source = await sourcePromise;
  const edit = block(source, "registerDeepSeekEdit", "registerDeepSeekFilesystemTools");
  assert.match(edit, /file_path:\s*Type\.String/);
  assert.match(edit, /old_string:\s*Type\.String/);
  assert.match(edit, /new_string:\s*Type\.String/);
  assert.match(edit, /replace_all:\s*Type\.Optional\(Type\.Boolean/);
  assert.match(edit, /path:\s*Type\.Optional\(Type\.String/);
  assert.match(edit, /edits:\s*Type\.Optional\(Type\.Array/);
  assert.match(edit, /prepareArguments:\s*prepareDeepSeekEditArgsForPi/);
});

test("DeepSeek read definition uses Harness file_path/offset/limit schema", async () => {
  const source = await sourcePromise;
  const read = block(source, "registerDeepSeekRead", "registerDeepSeekWrite");
  assert.match(read, /file_path:\s*Type\.String/);
  assert.match(read, /offset:\s*Type\.Optional\(Type\.Number/);
  assert.match(read, /limit:\s*Type\.Optional\(Type\.Number/);
});

test("write/edit use diff-call renderer instead of Pi native renderer", async () => {
  const source = await sourcePromise;
  const write = block(source, "registerDeepSeekWrite", "registerDeepSeekEdit");
  const edit = block(source, "registerDeepSeekEdit", "registerDeepSeekFilesystemTools");
  assert.match(write, /renderMutationCall\("write"/);
  assert.match(write, /renderMutationResult\("write"/);
  assert.match(edit, /renderMutationCall\("edit"/);
  assert.match(edit, /renderMutationResult\("edit"/);
});


test("DeepSeek write/edit force the default boxed shell instead of inheriting Pi built-in shells", async () => {
  const source = await sourcePromise;
  const write = block(source, "registerDeepSeekWrite", "registerDeepSeekEdit");
  const edit = block(source, "registerDeepSeekEdit", "registerDeepSeekFilesystemTools");
  assert.match(write, /renderShell:\s*"default"/);
  assert.match(edit, /renderShell:\s*"default"/);
});
