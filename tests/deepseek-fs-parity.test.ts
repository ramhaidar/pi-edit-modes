import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeepSeekFsParity,
  formatDeepSeekEditOutput,
  formatDeepSeekReadOutput,
  formatDeepSeekWriteOutput,
} from "../src/tools/deepseek/fs-parity.ts";

async function fixture(run: (cwd: string, fs: DeepSeekFsParity) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-dsh-fs-"));
  try { await run(cwd, new DeepSeekFsParity(cwd)); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

async function rejectsMessage(promise: Promise<unknown>, expected: string) {
  await assert.rejects(promise, (error: any) => {
    assert.equal(error?.message, expected);
    return true;
  });
}

test("write creates an unseen missing file and returns DeepSeek Harness envelope", async () => fixture(async (cwd, fs) => {
  const out = await fs.write("new.txt", "hello\n");
  assert.equal(out.operation, "create");
  assert.equal(await readFile(join(cwd, "new.txt"), "utf8"), "hello\n");
  assert.equal(formatDeepSeekWriteOutput(out.path, out.operation), `<path>${join(cwd, "new.txt")}</path>\n<type>file</type>\n<content>\nCreated file\n</content>`);
}));

test("write refuses blind overwrite until read", async () => fixture(async (cwd, fs) => {
  await writeFile(join(cwd, "a.txt"), "one\n");
  await rejectsMessage(fs.write("a.txt", "two\n"), `cannot overwrite existing "${join(cwd, "a.txt")}" without reading it first — read the file, then retry`);
  await fs.read("a.txt");
  const out = await fs.write("a.txt", "two\n");
  assert.equal(out.operation, "update");
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "two\n");
}));

test("write detects stale version after read", async () => fixture(async (cwd, fs) => {
  const path = join(cwd, "a.txt");
  await writeFile(path, "one\n");
  await fs.read("a.txt");
  await writeFile(path, "external-change\n");
  await rejectsMessage(fs.write("a.txt", "two\n"), `cannot write "${path}": file changed since it was read — re-read the file, then retry`);
}));

test("edit requires read and exact unique match by default", async () => fixture(async (cwd, fs) => {
  const path = join(cwd, "a.txt");
  await writeFile(path, "x\nx\n");
  await rejectsMessage(fs.edit("a.txt", "x", "y"), `edit requires reading "${path}" first — read the file, then retry`);
  await fs.read("a.txt");
  await rejectsMessage(fs.edit("a.txt", "x", "y"), `old_string matched 2 times in "${path}"; provide a more specific old_string or set replace_all to true`);
  const out = await fs.edit("a.txt", "x", "y", true);
  assert.equal(await readFile(path, "utf8"), "y\ny\n");
  assert.equal(formatDeepSeekEditOutput(out.path, true), `The file ${path} has been updated. All occurrences were successfully replaced.`);
}));

test("edit detects stale version before literal matching", async () => fixture(async (cwd, fs) => {
  const path = join(cwd, "a.txt");
  await writeFile(path, "before\n");
  await fs.read("a.txt");
  await writeFile(path, "new external text\n");
  await rejectsMessage(fs.edit("a.txt", "before", "after"), `cannot edit "${path}": file changed since it was read — re-read the file, then retry`);
}));

test("edit preserves CRLF while matching normalized LF strings", async () => fixture(async (cwd, fs) => {
  const path = join(cwd, "a.txt");
  await writeFile(path, "alpha\r\nbeta\r\n");
  await fs.read("a.txt");
  const out = await fs.edit("a.txt", "alpha\nbeta", "alpha\ngamma");
  assert.equal(out.before, "alpha\nbeta\n");
  assert.equal(out.after, "alpha\ngamma\n");
  assert.equal(await readFile(path, "utf8"), "alpha\r\ngamma\r\n");
}));

test("read line counting matches DeepSeek Harness trailing-newline behavior", async () => fixture(async (cwd, fs) => {
  const path = join(cwd, "a.txt");
  await writeFile(path, "a\nb\n");
  const out = await fs.read("a.txt");
  assert.equal(out.totalLines, 2);
  assert.deepEqual(out.lines, [{ number: 1, text: "a" }, { number: 2, text: "b" }]);
  assert.equal(formatDeepSeekReadOutput(out), `<path>${path}</path>\n<type>file</type>\n<content>\n1: a\n2: b\n\n(End of file - total 2 lines)\n</content>`);
}));

test("successful mutation updates observation so another edit can follow without reread", async () => fixture(async (cwd, fs) => {
  await fs.write("a.txt", "one two\n");
  await fs.edit("a.txt", "one", "1");
  await fs.edit("a.txt", "two", "2");
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "1 2\n");
}));

test("read absent records absence; write can then create", async () => fixture(async (cwd, fs) => {
  const path = join(cwd, "missing.txt");
  await rejectsMessage(fs.read("missing.txt"), `cannot read "${path}": not found`);
  await fs.write("missing.txt", "created");
  assert.equal(await readFile(path, "utf8"), "created");
}));

test("write preserves POSIX file mode on replacement", { skip: process.platform === "win32" }, async () => fixture(async (cwd, fs) => {
  const path = join(cwd, "mode.txt");
  await writeFile(path, "old");
  await chmod(path, 0o640);
  await fs.read("mode.txt");
  await fs.write("mode.txt", "new");
  assert.equal((await stat(path)).mode & 0o777, 0o640);
}));

test("symlink alias keeps identity and edits target without replacing symlink", { skip: process.platform === "win32" }, async () => fixture(async (cwd, fs) => {
  const target = join(cwd, "target.txt");
  const alias = join(cwd, "alias.txt");
  await writeFile(target, "old\n");
  await symlink(target, alias);
  await fs.read("alias.txt");
  await fs.edit("target.txt", "old", "new");
  assert.equal(await readFile(target, "utf8"), "new\n");
  assert.equal((await (await import("node:fs/promises")).lstat(alias)).isSymbolicLink(), true);
}));

test("argument validation mirrors tool-fs parsers", async () => fixture(async (_cwd, fs) => {
  await rejectsMessage(fs.write("   ", ""), "file_path must be a non-empty string");
  await rejectsMessage(fs.edit("x", "", "y"), "old_string must be a non-empty string");
  await rejectsMessage(fs.edit("x", "same", "same"), "old_string and new_string must differ");
  await rejectsMessage(fs.read("x", 0), "offset must be a positive integer");
  await rejectsMessage(fs.read("x", 1, 2001), "limit must be less than or equal to 2000");
}));

test("parallel writes from the same observation use the same CAS intent", async () => fixture(async (cwd, fs) => {
  const path = join(cwd, "race.txt");
  await writeFile(path, "base\n");
  await fs.read("race.txt");
  const settled = await Promise.allSettled([
    fs.write("race.txt", "first\n"),
    fs.write("race.txt", "second\n"),
  ]);
  assert.equal(settled.filter((x) => x.status === "fulfilled").length, 1);
  const rejected = settled.find((x): x is PromiseRejectedResult => x.status === "rejected");
  assert.ok(rejected);
  assert.match(String(rejected.reason?.message), /file changed since it was read — re-read the file, then retry$/);
}));

test("parallel creates are no-clobber: one creates and the other is not-observed", async () => fixture(async (cwd, fs) => {
  const path = join(cwd, "race-create.txt");
  const settled = await Promise.allSettled([
    fs.write("race-create.txt", "first\n"),
    fs.write("race-create.txt", "second\n"),
  ]);
  assert.equal(settled.filter((x) => x.status === "fulfilled").length, 1);
  const rejected = settled.find((x): x is PromiseRejectedResult => x.status === "rejected");
  assert.ok(rejected);
  assert.equal(rejected.reason?.message, `cannot overwrite existing "${path}" without reading it first — read the file, then retry`);
}));

test("parallel edits from the same observation do not chain through updated observation", async () => fixture(async (cwd, fs) => {
  const path = join(cwd, "race-edit.txt");
  await writeFile(path, "alpha beta\n");
  await fs.read("race-edit.txt");
  const settled = await Promise.allSettled([
    fs.edit("race-edit.txt", "alpha", "A"),
    fs.edit("race-edit.txt", "beta", "B"),
  ]);
  assert.equal(settled.filter((x) => x.status === "fulfilled").length, 1);
  const rejected = settled.find((x): x is PromiseRejectedResult => x.status === "rejected");
  assert.ok(rejected);
  assert.equal(rejected.reason?.message, `cannot edit "${path}": file changed since it was read — re-read the file, then retry`);
}));

test("str_replace_editor view observation is shared with generic edit", async () => fixture(async (cwd, fs) => {
  const path = join(cwd, "shared-view.txt");
  await writeFile(path, "alpha beta\n");
  const viewed = await fs.editorView(path);
  assert.equal(viewed.content, "alpha beta\n");
  await fs.edit(path, "alpha", "A");
  assert.equal(await readFile(path, "utf8"), "A beta\n");
}));

test("generic read observation is shared with str_replace_editor mutation", async () => fixture(async (cwd, fs) => {
  const path = join(cwd, "shared-edit.txt");
  await writeFile(path, "alpha beta\n");
  await fs.read(path);
  const outcome = await fs.editorReplace(path, "beta", "B");
  assert.equal(outcome.after, "alpha B\n");
  assert.equal(await readFile(path, "utf8"), "alpha B\n");
}));

test("str_replace_editor edit-intent errors are raw Harness errors", async () => fixture(async (cwd, fs) => {
  const path = join(cwd, "unread.txt");
  await writeFile(path, "alpha\n");
  await rejectsMessage(fs.editorReplace(path, "alpha", "A"), `edit requires reading "${path}" first`);
}));

test("str_replace_editor duplicate error reports every occurrence line", async () => fixture(async (cwd, fs) => {
  const path = join(cwd, "dupes.txt");
  await writeFile(path, "x\ny\nx\nx\n");
  await fs.editorView(path);
  await rejectsMessage(
    fs.editorReplace(path, "x", "z"),
    `No replacement was performed. Multiple occurrences of old_str \`x\` in lines [1, 3, 4]. Please ensure it is unique`,
  );
}));

test("str_replace_editor create observes the created version for a following generic edit", async () => fixture(async (cwd, fs) => {
  const path = join(cwd, "created.txt");
  await fs.editorCreate(path, "one two\n");
  await fs.edit(path, "two", "2");
  assert.equal(await readFile(path, "utf8"), "one 2\n");
}));
