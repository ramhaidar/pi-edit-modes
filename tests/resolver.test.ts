import test from "node:test";
import assert from "node:assert/strict";
import { resolveMode } from "../src/config/resolver.ts";
import { DEFAULT_SETTINGS } from "../src/config/schema.ts";
import { MutableModelOverrideMap, parseModelOverrides } from "../src/config/models-config.ts";

function resolve(provider: string, id: string, settings = structuredClone(DEFAULT_SETTINGS), overrides = new MutableModelOverrideMap(), sessionOverride: any = "auto") {
  return resolveMode({ model: { provider, id }, settings, overrides, sessionOverride });
}

test("detects Gemini across providers", () => {
  assert.equal(resolve("google", "gemini-3-pro").mode, "gemini");
  assert.equal(resolve("vertex", "gemini-2.5-pro").mode, "gemini");
  assert.equal(resolve("openrouter", "google-gemini-3").mode, "gemini");
});

test("detects DeepSeek across providers", () => {
  assert.equal(resolve("deepseek", "deepseek-v3.2").mode, "deepseek");
  assert.equal(resolve("openrouter", "deepseek/deepseek-v3.2").mode, "deepseek");
});

test("detects Codex by strong provider and token", () => {
  assert.equal(resolve("openai-codex", "gpt-5.3").mode, "codex");
  assert.equal(resolve("custom", "gpt-5.3-codex-proxy").mode, "codex");
});

test("does not classify ordinary OpenAI as Codex", () => {
  assert.equal(resolve("openai", "gpt-5.4").mode, "pi");
});

test("explicit model override wins over detection", () => {
  const overrides = new MutableModelOverrideMap();
  overrides.set("google", "gemini-3-pro", "pi");
  const result = resolve("google", "gemini-3-pro", structuredClone(DEFAULT_SETTINGS), overrides);
  assert.equal(result.mode, "pi");
  assert.equal(result.source, "models.json");
});

test("session override wins over explicit model override", () => {
  const overrides = new MutableModelOverrideMap();
  overrides.set("google", "gemini-3-pro", "pi");
  assert.equal(resolve("google", "gemini-3-pro", structuredClone(DEFAULT_SETTINGS), overrides, "codex").mode, "codex");
});

test("auto discovery can be disabled", () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.defaultMode = "codex";
  settings.autoDiscovery.enabled = false;
  assert.equal(resolve("google", "gemini-3-pro", settings).mode, "codex");
});

test("individual detection families can be disabled", () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.autoDiscovery.gemini = false;
  assert.equal(resolve("google", "gemini-3-pro", settings).mode, "pi");

  settings.autoDiscovery.gemini = true;
  settings.autoDiscovery.deepseek = false;
  assert.equal(resolve("deepseek", "deepseek-v3", settings).mode, "pi");

  settings.autoDiscovery.deepseek = true;
  settings.autoDiscovery.codex = false;
  assert.equal(resolve("openai-codex", "gpt-5.3-codex", settings).mode, "pi");
});

test("parses custom model and modelOverrides metadata", () => {
  const parsed = parseModelOverrides({ providers: {
    proxy: { models: [{ id: "m1", "x-pi-tool-mode": "gemini" }] },
    openai: { modelOverrides: { "gpt-5.4": { "x-pi-tool-mode": "pi" } } },
  } });
  assert.equal(parsed.overrides.get("proxy", "m1"), "gemini");
  assert.equal(parsed.overrides.get("openai", "gpt-5.4"), "pi");
  assert.deepEqual(parsed.warnings, []);
});

test("invalid model override is ignored with warning", () => {
  const parsed = parseModelOverrides({ providers: { x: { models: [{ id: "m", "x-pi-tool-mode": "wat" }] } } });
  assert.equal(parsed.overrides.get("x", "m"), undefined);
  assert.equal(parsed.warnings.length, 1);
});
