import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings, DEFAULT_SETTINGS } from "../src/config/schema.ts";
import { EditModesConfigStore } from "../src/config/settings-store.ts";

test("invalid config falls back to compiled defaults", () => {
  const parsed = parseSettings({ defaultMode: "wat" });
  assert.deepEqual(parsed.settings, DEFAULT_SETTINGS);
  assert.match(parsed.warning ?? "", /Invalid defaultMode/);
});

test("valid partial config merges with defaults", () => {
  const parsed = parseSettings({ version: 1, defaultMode: "gemini", surface: "additive", autoDiscovery: { codex: false } });
  assert.equal(parsed.settings.defaultMode, "gemini");
  assert.equal(parsed.settings.surface, "additive");
  assert.equal(parsed.settings.autoDiscovery.enabled, true);
  assert.equal(parsed.settings.autoDiscovery.codex, false);
  assert.equal(parsed.settings.autoDiscovery.deepseek, true);
});

test("legacy codex.surface migrates to universal surface", () => {
  const parsed = parseSettings({ version: 1, codex: { surface: "additive" } });
  assert.equal(parsed.settings.surface, "additive");
  assert.equal("codex" in parsed.settings, false);
});

test("settings store persists JSON and reloads it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-edit-modes-"));
  try {
    const store = new EditModesConfigStore(dir);
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.defaultMode = "codex";
    settings.surface = "additive";
    settings.gemini.strictExactMatch = false;
    await store.save(settings);
    const raw = await readFile(join(dir, "edit-modes.json"), "utf8");
    assert.equal(JSON.parse(raw).defaultMode, "codex");
    assert.equal(JSON.parse(raw).surface, "additive");
    const snap = await store.refresh(true);
    assert.equal(snap.settings.surface, "additive");
    assert.equal(snap.settings.gemini.strictExactMatch, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
