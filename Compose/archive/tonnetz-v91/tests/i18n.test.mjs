import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const root = new URL("../public/tonnetz/", import.meta.url);
const [i18nSource, html, app, manifest, sw] = await Promise.all([
  readFile(new URL("i18n.js", root), "utf8"),
  readFile(new URL("index.html", root), "utf8"),
  readFile(new URL("app.js", root), "utf8"),
  readFile(new URL("manifest.webmanifest", root), "utf8"),
  readFile(new URL("sw.js", root), "utf8")
]);

function loadI18n(savedLanguage = null) {
  const store = new Map(savedLanguage ? [["guangge-language", savedLanguage]] : []);
  const events = [];
  const documentElement = { lang: "en", removeAttribute(name) { this.removed = name; } };
  const document = {
    readyState: "complete",
    documentElement,
    title: "",
    querySelectorAll: () => []
  };
  class CustomEvent {
    constructor(type, options) { this.type = type; this.detail = options?.detail; }
  }
  const window = {
    localStorage: {
      getItem: (key) => store.get(key) || null,
      setItem: (key, value) => store.set(key, String(value))
    },
    dispatchEvent: (event) => events.push(event)
  };
  const context = vm.createContext({ window, document, CustomEvent, console });
  vm.runInContext(i18nSource, context);
  return { api: window.TonnetzI18n, store, events, document };
}

test("English is the default and an invalid stored language cannot override it", () => {
  assert.equal(loadI18n().api.getLanguage(), "en");
  assert.equal(loadI18n("fr").api.getLanguage(), "en");
  assert.equal(loadI18n().api.t("start.enable"), "Tap to enable sound");
});

test("Chinese selection persists and announces one explicit language update", () => {
  const { api, store, events, document } = loadI18n();
  assert.equal(api.setLanguage("zh-CN"), "zh-CN");
  assert.equal(store.get("guangge-language"), "zh-CN");
  assert.equal(api.t("start.enable"), "轻触启用声音");
  assert.equal(document.documentElement.lang, "zh-CN");
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.language, "zh-CN");
});

test("every declarative HTML translation key exists in both dictionaries", () => {
  const patterns = [
    /data-i18n="([^"]+)"/g,
    /data-i18n-aria-label="([^"]+)"/g,
    /data-i18n-content="([^"]+)"/g,
    /data-i18n-label="([^"]+)"/g
  ];
  const keys = new Set(patterns.flatMap((pattern) => [...html.matchAll(pattern)].map((match) => match[1])));
  const { api } = loadI18n();
  for (const language of ["en", "zh-CN"]) {
    api.setLanguage(language);
    for (const key of keys) assert.notEqual(api.t(key), key, `${language} is missing ${key}`);
  }
});

test("every app translation key exists and runtime messages can change language", () => {
  const directKeys = [...app.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]);
  const modelKeys = [...app.matchAll(/(?:nameKey|hintKey):\s*"([^"]+)"/g)].map((match) => match[1]);
  const statusKeys = [...app.matchAll(/(?:stopEverything|updateKeyboardPitches)\("([^"]+)"/g)].map((match) => match[1]);
  const keys = new Set([...directKeys, ...modelKeys, ...statusKeys]);
  const { api } = loadI18n();

  for (const language of ["en", "zh-CN"]) {
    api.setLanguage(language);
    for (const key of keys) assert.notEqual(api.t(key), key, `${language} lacks ${key}`);
  }

  api.setLanguage("en");
  assert.equal(api.t("status.voiceSelected", { voice: api.t("voice.flute") }), "Voice: Flute");
  api.setLanguage("zh-CN");
  assert.equal(api.t("status.voiceSelected", { voice: api.t("voice.flute") }), "音色：长笛");
});

test("the first paint is English and language changes use explicit rendering", () => {
  assert.match(html, /^<!doctype html>[\s\S]*<html lang="en" data-i18n-pending>/);
  assert.ok(html.indexOf("i18n.js?v=1") < html.indexOf("app.css?v=20"));
  assert.match(html, /Tap to enable sound/);
  const withoutLanguageChoice = html.replace("<option value=\"zh-CN\">中文</option>", "");
  assert.doesNotMatch(withoutLanguageChoice, /[\p{Script=Han}]/u);
  assert.doesNotMatch(app, /[\p{Script=Han}]/u);
  assert.doesNotMatch(i18nSource, /MutationObserver/);
  assert.match(app, /tonnetzlanguagechange/);
  assert.match(app, /refreshLocalizedUI/);
});

test("the service worker and manifest use the new English-first assets", () => {
  const parsedManifest = JSON.parse(manifest);
  assert.equal(parsedManifest.lang, "en");
  assert.match(parsedManifest.name, /Isomorphic keyboard/);
  for (const asset of ["./i18n.js?v=1", "./app.css?v=20", "./app.js?v=21"]) assert.match(sw, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(sw, /tonnetz-v38-melodic-phrases/);
});
