import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { WARNING_CODES } from "../src/core/model";
import { en } from "../src/i18n/en";
import { ko } from "../src/i18n/ko";
import { resolveExtLang, resolveLang, t } from "../src/i18n";
import { ROOT, runCli } from "./helpers";

test("en and ko define exactly the same keys and every placeholder matches", () => {
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(Object.keys(ko).sort(), enKeys);
  const holes = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort();
  for (const k of enKeys) {
    assert.deepEqual(holes(ko[k as keyof typeof ko]), holes(en[k as keyof typeof en]), k);
  }
});

test("every warning code has a message in both languages", () => {
  for (const code of WARNING_CODES) {
    assert.ok((en as Record<string, string>)[`w.${code}`], code);
    assert.ok((ko as Record<string, string>)[`w.${code}`], code);
  }
});

test("package.nls.json and package.nls.ko.json have the same keys, and every %key% in package.json exists", () => {
  const nls = JSON.parse(fs.readFileSync(path.join(ROOT, "package.nls.json"), "utf8"));
  const nlsKo = JSON.parse(fs.readFileSync(path.join(ROOT, "package.nls.ko.json"), "utf8"));
  assert.deepEqual(Object.keys(nlsKo).sort(), Object.keys(nls).sort());
  const pkg = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
  for (const [, key] of pkg.matchAll(/"%([^%"]+)%"/g)) assert.ok(key in nls, key);
});

test("language priority: --lang > MCP_UNISON_LANG > LC_ALL > LC_MESSAGES > LANG, default English", () => {
  assert.equal(resolveLang({ flag: "ko", env: { MCP_UNISON_LANG: "en" } }), "ko");
  assert.equal(resolveLang({ env: { MCP_UNISON_LANG: "ko", LC_ALL: "en_US.UTF-8" } }), "ko");
  assert.equal(resolveLang({ env: { LC_ALL: "ko_KR.UTF-8", LANG: "en_US.UTF-8" } }), "ko");
  assert.equal(resolveLang({ env: { LC_MESSAGES: "ko_KR.UTF-8", LANG: "en_US.UTF-8" } }), "ko");
  assert.equal(resolveLang({ env: { LANG: "ko_KR.UTF-8" } }), "ko");
  assert.equal(resolveLang({ env: { LANG: "de_DE.UTF-8" } }), "en");
  assert.equal(resolveLang({ env: {} }), "en");
  assert.equal(resolveLang({ flag: "xx", env: { MCP_UNISON_LANG: "nonsense", LANG: "ko_KR" } }), "ko");
});

test("extension language: setting beats the editor language", () => {
  assert.equal(resolveExtLang("en", "ko"), "en");
  assert.equal(resolveExtLang("ko", "en"), "ko");
  assert.equal(resolveExtLang("auto", "ko"), "ko");
  assert.equal(resolveExtLang("auto", "fr"), "en");
  assert.equal(resolveExtLang(undefined, undefined), "en");
});

test("t() fills placeholders", () => {
  assert.equal(t("en", "cli.err.needValue", { name: "--home" }), "option --home needs a value.");
  assert.ok(t("ko", "cli.err.needValue", { name: "--home" }).includes("--home"));
});

test("CLI --help switches language", () => {
  const ko1 = runCli(["--help", "--lang", "ko"], { LANG: "en_US.UTF-8" });
  assert.equal(ko1.status, 0);
  assert.match(ko1.stdout, /사용법/);
  const en1 = runCli(["--help", "--lang", "en"], { LANG: "ko_KR.UTF-8" });
  assert.match(en1.stdout, /Usage/);
  assert.doesNotMatch(en1.stdout, /사용법/);
  assert.match(runCli(["--help"], { MCP_UNISON_LANG: "ko" }).stdout, /사용법/);
  assert.match(runCli(["--help"], { LC_ALL: "ko_KR.UTF-8" }).stdout, /사용법/);
  assert.match(runCli(["--help"], {}).stdout, /Usage/);
});

test("--version prints the package version", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(runCli(["--version"]).stdout.trim(), pkg.version);
});
