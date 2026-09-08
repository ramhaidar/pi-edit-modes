import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePiJsonText, readModelOverrides } from "../src/config/models-config.ts";

test("Pi lexical JSON format accepts BOM, line comments, and block comments", () => {
  const value = parsePiJsonText(`\ufeff{\n  // line comment\n  "url": "https://example.test/a//b",\n  /* block\n     comment */\n  "value": 1\n}`) as any;
  assert.equal(value.url, "https://example.test/a//b");
  assert.equal(value.value, 1);
});

test("models.json override loads through Pi-compatible BOM/comment stripping", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-model-overrides-"));
  try {
    const path = join(dir, "models.json");
    await writeFile(path, `\ufeff{\n  // Gemini through custom endpoint\n  "providers": {\n    "google": {\n      "models": [\n        {\n          "id": "gemini-x",\n          "x-pi-tool-mode": "codex"\n        }\n      ]\n    }\n  }\n}\n`, "utf8");
    const parsed = await readModelOverrides(path);
    assert.deepEqual(parsed.warnings, []);
    assert.equal(parsed.overrides.get("google", "gemini-x"), "codex");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
