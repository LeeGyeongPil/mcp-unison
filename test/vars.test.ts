import * as assert from "node:assert/strict";
import { test } from "node:test";
import { claudeEntryToSpec } from "../src/core/readers/claude";
import { planCopilotSync, toCopilotEntries } from "../src/core/targets/copilot";
import { toProviderDefs } from "../src/core/targets/provider";
import { blankBlocked, blockedSet, expand } from "../src/core/vars";

const blocked = blockedSet();
const stdioOpts = { remote: false, blocked };
const remoteOpts = { remote: true, blocked };

test("an unset variable stays as literal text and is reported", () => {
  const r = expand("Bearer ${TOKEN}", {}, stdioOpts);
  assert.equal(r.value, "Bearer ${TOKEN}");
  assert.deepEqual(r.unset, ["TOKEN"]);
});

test("a default is used only when the variable is unset", () => {
  assert.equal(expand("${A:-fallback}", {}, stdioOpts).value, "fallback");
  assert.equal(expand("${A:-fallback}", { A: "set" }, stdioOpts).value, "set");
});

test("an empty string is a set value, so the default is not used", () => {
  const r = expand("${A:-d}", { A: "" }, stdioOpts);
  assert.equal(r.value, "");
  assert.deepEqual(r.unset, []);
  assert.equal(expand("x${A}y", { A: "" }, stdioOpts).value, "xy");
});

test("plain $VAR without braces is left alone", () => {
  assert.equal(expand("$HOME/${HOME}", { HOME: "/h" }, stdioOpts).value, "$HOME//h");
});

test("credential variables are blank in remote servers whatever their value or default", () => {
  const r = expand("Bearer ${NPM_TOKEN} ${ANTHROPIC_API_KEY:-dflt}", { NPM_TOKEN: "abc", ANTHROPIC_API_KEY: "k" }, remoteOpts);
  assert.equal(r.value, "Bearer  ");
  assert.deepEqual(r.blocked, ["NPM_TOKEN", "ANTHROPIC_API_KEY"]);
});

test("the same variables expand normally in stdio env", () => {
  const r = expand("${NPM_TOKEN}", { NPM_TOKEN: "abc" }, stdioOpts);
  assert.equal(r.value, "abc");
  assert.deepEqual(r.blocked, []);
});

test("extra blocked names can be added", () => {
  const extra = blockedSet(["MY_SECRET"]);
  assert.equal(expand("${MY_SECRET}", { MY_SECRET: "s" }, { remote: true, blocked: extra }).value, "");
});

test("mode A leaves out a server with an unset variable and keeps the rest", () => {
  const ok = claudeEntryToSpec("ok", { command: "node", env: { A: "${A_SET}" } }, "claude-user");
  const bad = claudeEntryToSpec("bad", { type: "http", url: "https://x.invalid", headers: { Authorization: "Bearer ${MISSING}" } }, "claude-user");
  const r = toProviderDefs([ok, bad], { A_SET: "1" }, { blocked });
  assert.deepEqual(r.defs.map((d) => d.name), ["ok"]);
  assert.ok(r.warnings.some((w) => w.code === "W_UNSET_VAR" && w.server === "bad" && w.detail === "MISSING"));
  const def = r.defs[0];
  assert.equal(def.kind === "stdio" && def.env.A, "1");
});

test("mode A turns a blocked remote variable into an empty header and warns", () => {
  const s = claudeEntryToSpec("remote", { type: "http", url: "https://x.invalid", headers: { H: "${NPM_TOKEN}" } }, "claude-user");
  const r = toProviderDefs([s], { NPM_TOKEN: "real" }, { blocked });
  const def = r.defs[0];
  assert.equal(def.kind === "http" && def.headers.H, "");
  assert.ok(r.warnings.some((w) => w.code === "W_BLOCKED_SECRET_VAR"));
});

test("mode A version is stable for equal input and changes with content", () => {
  const a = claudeEntryToSpec("s", { command: "node", args: ["a.js"] }, "claude-user");
  const b = claudeEntryToSpec("s", { command: "node", args: ["b.js"] }, "claude-user");
  const v1 = toProviderDefs([a], {}, { blocked }).defs[0].version;
  const v2 = toProviderDefs([a], {}, { blocked }).defs[0].version;
  const v3 = toProviderDefs([b], {}, { blocked }).defs[0].version;
  assert.equal(v1, v2);
  assert.notEqual(v1, v3);
  assert.match(v1, /^[0-9a-f]{12}$/);
});

test("blankBlocked keeps ordinary variables as text", () => {
  const r = blankBlocked("${A}-${NPM_TOKEN}", blocked);
  assert.equal(r.value, "${A}-");
});

test("mode B output never contains an environment variable value", () => {
  const SECRET = "s3cr3t-value-XYZ";
  process.env.MCP_UNISON_TEST_TOKEN = SECRET;
  process.env.NPM_TOKEN = SECRET;
  try {
    const servers = [
      claudeEntryToSpec("a", { command: "node", env: { T: "${MCP_UNISON_TEST_TOKEN}" } }, "claude-user"),
      claudeEntryToSpec("b", { type: "http", url: "https://x.invalid", headers: { Authorization: "Bearer ${MCP_UNISON_TEST_TOKEN}", X: "${NPM_TOKEN}" } }, "claude-user"),
    ];
    const desired = toCopilotEntries(servers, blocked);
    const plan = planCopilotSync(desired, undefined, { version: 1, managed: {} }, { copilotConfig: "/nope/mcp-config.json", lockFile: "/nope/lock.json" });
    assert.ok(!plan.newText.includes(SECRET));
    assert.ok(!plan.newLockText.includes(SECRET));
    assert.ok(plan.newText.includes("${MCP_UNISON_TEST_TOKEN}"));
  } finally {
    delete process.env.MCP_UNISON_TEST_TOKEN;
    delete process.env.NPM_TOKEN;
  }
});

test("mode B skips an http server whose url still holds a variable", () => {
  const s = claudeEntryToSpec("u", { type: "http", url: "${BASE}/mcp" }, "claude-user");
  const d = toCopilotEntries([s], blocked);
  assert.equal(d.entries.size, 0);
  assert.equal(d.skipped.get("u"), "W_URL_VAR_COPILOT");
});
