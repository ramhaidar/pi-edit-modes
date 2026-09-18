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
  const parsed = parseSettings({
    version: 1,
    defaultMode: "gemini",
    surface: "additive",
    autoDiscovery: { codex: false },
  });
  assert.equal(parsed.settings.defaultMode, "gemini");
  assert.equal(parsed.settings.surface, "additive");
  assert.equal(parsed.settings.bashOnly, false);
  assert.equal(parsed.settings.autoDiscovery.enabled, true);
  assert.equal(parsed.settings.autoDiscovery.codex, false);
  assert.equal(parsed.settings.autoDiscovery.deepseek, true);
  assert.equal(parsed.settings.gemini.approval, "ask_user");
  assert.equal(parsed.settings.gemini.disableLLMCorrection, true);
  assert.deepEqual(parsed.settings.gemini.fileFiltering, {
    respectGitIgnore: true,
    respectGeminiIgnore: true,
    customIgnoreFilePaths: [],
  });
  assert.equal(parsed.settings.deepseek.preset, "standard");
});

test("all is a valid default and session tool mode", () => {
  const parsed = parseSettings({ version: 1, defaultMode: "all" });
  assert.equal(parsed.warning, undefined);
  assert.equal(parsed.settings.defaultMode, "all");
});

test("bashOnly defaults to false and accepts an explicit boolean", () => {
  assert.equal(DEFAULT_SETTINGS.bashOnly, false);
  const parsed = parseSettings({ version: 1, bashOnly: true });
  assert.equal(parsed.warning, undefined);
  assert.equal(parsed.settings.bashOnly, true);
});

test("invalid bashOnly falls back to defaults with a warning", () => {
  const parsed = parseSettings({ version: 1, bashOnly: "yes" });
  assert.deepEqual(parsed.settings, DEFAULT_SETTINGS);
  assert.match(parsed.warning ?? "", /bashOnly must be boolean/);
});

test("legacy settings files without bashOnly still load", () => {
  const parsed = parseSettings({
    version: 1,
    defaultMode: "codex",
    surface: "additive",
    codex: { surface: "additive" },
  });
  assert.equal(parsed.warning, undefined);
  assert.equal(parsed.settings.bashOnly, false);
});

test("legacy gemini.strictExactMatch is accepted but no longer projected", () => {
  const parsed = parseSettings({ version: 1, gemini: { strictExactMatch: false } });
  assert.equal(parsed.warning, undefined);
  assert.deepEqual(parsed.settings.gemini, DEFAULT_SETTINGS.gemini);
});

test("Gemini file filtering settings match upstream defaults and custom configuration", () => {
  const parsed = parseSettings({
    version: 1,
    gemini: {
      fileFiltering: {
        respectGitIgnore: false,
        respectGeminiIgnore: false,
        customIgnoreFilePaths: [".aiignore", "config/private.ignore"],
      },
    },
  });
  assert.equal(parsed.warning, undefined);
  assert.deepEqual(parsed.settings.gemini.fileFiltering, {
    respectGitIgnore: false,
    respectGeminiIgnore: false,
    customIgnoreFilePaths: [".aiignore", "config/private.ignore"],
  });

  const invalid = parseSettings({
    version: 1,
    gemini: { fileFiltering: { customIgnoreFilePaths: [".aiignore", 42] } },
  });
  assert.match(invalid.warning ?? "", /customIgnoreFilePaths must be an array of strings/);
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
    settings.gemini.approval = "auto_edit";
    settings.gemini.disableLLMCorrection = false;
    settings.gemini.fileFiltering.respectGitIgnore = false;
    settings.gemini.fileFiltering.customIgnoreFilePaths = [".customignore"];
    settings.deepseek.preset = "minimal";
    settings.bashOnly = true;
    await store.save(settings);
    const raw = await readFile(join(dir, "edit-modes.json"), "utf8");
    assert.equal(JSON.parse(raw).defaultMode, "codex");
    assert.equal(JSON.parse(raw).surface, "additive");
    assert.equal(JSON.parse(raw).bashOnly, true);
    const snap = await store.refresh(true);
    assert.equal(snap.settings.surface, "additive");
    assert.equal(snap.settings.gemini.approval, "auto_edit");
    assert.equal(snap.settings.gemini.disableLLMCorrection, false);
    assert.equal(snap.settings.gemini.fileFiltering.respectGitIgnore, false);
    assert.deepEqual(snap.settings.gemini.fileFiltering.customIgnoreFilePaths, [".customignore"]);
    assert.equal(snap.settings.deepseek.preset, "minimal");
    assert.equal(snap.settings.bashOnly, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
