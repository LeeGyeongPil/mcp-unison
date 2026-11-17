import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { computeDrift } from "../src/core/drift";
import { loadSources } from "../src/core/merge";
import { findLocalKey } from "../src/core/paths";
import { applyCopilotSync, editEntry, planCopilotSync, readLock } from "../src/core/targets/copilot";
import { blockedSet } from "../src/core/vars";
import { runCli, tmpDir, writeTree } from "./helpers";

async function run(home: string, project: string) {
  const set = await loadSources({ home, projectDir: project, env: {} });
  const lock = readLock(set.paths.lockFile);
  const report = computeDrift(set, { env: {}, blocked: blockedSet(), lock });
  return { report, plan: planCopilotSync(report.desired, set.copilot, lock, set.paths) };
}

function twoProjects(t: import("node:test").TestContext) {
  const home = tmpDir(t);
  const a = path.join(home, "projA");
  const b = path.join(home, "projB");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  writeTree(home, {
    ".claude.json": {
      mcpServers: { u: { command: "user-server" } },
      projects: { [a]: { mcpServers: { "a-only": { command: "a-server" } } } },
    },
  });
  return { home, a, b };
}

// Q-1
test("a local-scope server is never written to the global Copilot config", async (t) => {
  const { home, a } = twoProjects(t);
  const { report, plan } = await run(home, a);
  assert.deepEqual([...report.desired.entries.keys()], ["u"]);
  assert.ok(report.warnings.some((w) => w.code === "W_LOCAL_SCOPE_NOT_SYNCED" && w.server === "a-only"));
  assert.equal(report.rows.find((r) => r.name === "a-only")?.status, "skipped");
  applyCopilotSync(plan);
  const text = fs.readFileSync(path.join(home, ".copilot", "mcp-config.json"), "utf8");
  assert.ok(!text.includes("a-only"));
});

test("syncing from a second project does not plan to remove anything", async (t) => {
  const { home, a, b } = twoProjects(t);
  applyCopilotSync((await run(home, a)).plan);
  const second = await run(home, b);
  assert.equal(second.plan.changed, false);
  assert.ok(second.plan.actions.every((x) => x.action === "unchanged"));
  const cli = runCli(["sync-copilot", "--home", home, "--project", b, "--lang", "en"]);
  assert.match(cli.stdout, /no changes/);
});

test("a local server shadowing a global one still syncs the global definition", async (t) => {
  const home = tmpDir(t);
  const p = path.join(home, "proj");
  fs.mkdirSync(p);
  writeTree(home, {
    ".claude.json": {
      mcpServers: { s: { command: "global-s" } },
      projects: { [p]: { mcpServers: { s: { command: "local-s" } } } },
    },
  });
  const { report } = await run(home, p);
  assert.equal((report.desired.entries.get("s") as { command: string }).command, "global-s");
});

test("a managed entry that is no longer wanted is reported as stale-managed and counts as drift", async (t) => {
  const { home, a } = twoProjects(t);
  applyCopilotSync((await run(home, a)).plan);
  writeTree(home, { ".claude.json": { mcpServers: {} } });
  const { report } = await run(home, a);
  assert.equal(report.rows.find((r) => r.name === "u")?.status, "stale-managed");
  const cli = runCli(["diff", "--check", "--home", home, "--project", a, "--lang", "en"]);
  assert.equal(cli.status, 1);
});

// Q-2
test("--write keeps the file mode of the Copilot config and the lock file is 0600", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX modes");
  const { home, a } = twoProjects(t);
  const file = path.join(home, ".copilot", "mcp-config.json");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '{"mcpServers":{}}\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  applyCopilotSync((await run(home, a)).plan);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${file}.bak`).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(home, ".copilot", "mcp-unison.lock.json")).mode & 0o777, 0o600);
});

test("--write follows a symlinked config instead of replacing it", async (t) => {
  if (process.platform === "win32") return t.skip("symlinks");
  const { home, a } = twoProjects(t);
  const real = path.join(home, "dotfiles", "mcp-config.json");
  fs.mkdirSync(path.dirname(real));
  fs.writeFileSync(real, '{"mcpServers":{}}\n');
  fs.mkdirSync(path.join(home, ".copilot"));
  const link = path.join(home, ".copilot", "mcp-config.json");
  fs.symlinkSync(real, link);
  applyCopilotSync((await run(home, a)).plan);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.readFileSync(real, "utf8").includes('"u"'));
});

// Q-3
test("--lang ko prints source file errors in Korean with the path and line", (t) => {
  const home = tmpDir(t);
  writeTree(home, { ".claude.json": '{\n  "a": }\n' });
  const r = runCli(["list", "--home", home, "--lang", "ko"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes(`${home}/.claude.json`), r.stderr);
  assert.match(r.stderr, /JSON 형식이 잘못되었습니다 \(2줄/);
  assert.doesNotMatch(r.stderr, /invalid JSON/);
  const en = runCli(["list", "--home", home, "--lang", "en"]);
  assert.match(en.stderr, /invalid JSON at line 2/);
});

test("Korean errors for a non-object file, broken TOML and a bad lock file", (t) => {
  const home = tmpDir(t);
  writeTree(home, { ".claude.json": "[1]\n" });
  assert.match(runCli(["list", "--home", home, "--lang", "ko"]).stderr, /최상위 값이 JSON 객체가 아닙니다/);
  writeTree(home, { ".claude.json": "{}\n", ".codex/config.toml": "[[[" });
  assert.match(runCli(["list", "--home", home, "--lang", "ko"]).stderr, /TOML 형식이 잘못되었습니다/);
  fs.rmSync(path.join(home, ".codex"), { recursive: true });
  writeTree(home, { ".copilot/mcp-unison.lock.json": '{"x":1}' });
  const r = runCli(["diff", "--home", home, "--lang", "ko"]);
  assert.match(r.stderr, /잠금 파일은/);
  assert.ok(r.stderr.includes(path.join(home, ".copilot", "mcp-unison.lock.json")));
});

test("editEntry errors carry the real file path", () => {
  assert.throws(() => editEntry("[1]", "a", {}, "/x/mcp-config.json"), /\/x\/mcp-config\.json/);
  assert.throws(() => editEntry('{"mcpServers": 1}', "a", {}, "/x/mcp-config.json"), /\/x\/mcp-config\.json/);
});

// Q-5
test("removing an entry keeps the comments around it", () => {
  const base = '{\n  "mcpServers": {\n    "a": {"c":1},\n    // about b\n    "b": {"c":2},\n    "z": {"c":3}\n    // about end\n  }\n}\n';
  const noA = editEntry(base, "a", undefined);
  assert.ok(noA.includes("// about b"));
  assert.deepEqual(Object.keys(JSON.parse(noA.replace(/\/\/.*$/gm, "")).mcpServers), ["b", "z"]);
  const noZ = editEntry(base, "z", undefined);
  assert.ok(noZ.includes("// about end"));
  assert.deepEqual(Object.keys(JSON.parse(noZ.replace(/\/\/.*$/gm, "")).mcpServers), ["a", "b"]);
  const noB = editEntry(base, "b", undefined);
  assert.ok(!noB.includes('"b"'));
  assert.deepEqual(Object.keys(JSON.parse(noB.replace(/\/\/.*$/gm, "")).mcpServers), ["a", "z"]);
});

// Q-6
test("a kept user entry is not drift, so diff --check stays 0 and the hint points to renaming", async (t) => {
  const home = tmpDir(t);
  writeTree(home, {
    ".claude.json": { mcpServers: { docs: { command: "docs-v1" } } },
    ".copilot/mcp-config.json": { mcpServers: { docs: { command: "mine" } } },
  });
  const r = runCli(["diff", "--check", "--home", home, "--lang", "en"]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /kept-user/);
  assert.match(r.stdout, /rename or delete your entry/);
  assert.match(runCli(["sync-copilot", "--home", home, "--lang", "en"]).stdout, /no changes/);
});

// Q-8
test("the nearest-key hint ignores sibling projects but finds case and parent changes", () => {
  assert.deepEqual(findLocalKey(["/w/projA"], "/w/projB", "linux"), {});
  assert.deepEqual(findLocalKey(["/w/a-long-project-name-1"], "/w/a-long-project-name-2", "linux"), {});
  assert.deepEqual(findLocalKey(["/W/ProjA"], "/w/projA", "linux"), { nearest: "/W/ProjA" });
  assert.deepEqual(findLocalKey(["/old/parent/app"], "/new/parent/app", "linux"), { nearest: "/old/parent/app" });
});
