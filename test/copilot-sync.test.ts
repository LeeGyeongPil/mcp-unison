import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { computeDrift } from "../src/core/drift";
import { loadSources } from "../src/core/merge";
import { applyCopilotSync, planCopilotSync, readLock } from "../src/core/targets/copilot";
import { blockedSet } from "../src/core/vars";
import { unifiedDiff } from "../src/core/textdiff";
import { copyDemo, runCli, tmpDir, writeTree } from "./helpers";

const USER_TEXT = `{
  // my own notes, keep me
  "mcpServers": {
    "mine":   {"command":"mine-server",  "args":["--x"]}
  },
  "trustedFolders": ["/keep/me"]
}
`;

async function plan(home: string, project?: string) {
  const set = await loadSources({ home, projectDir: project, env: {} });
  const report = computeDrift(set, { env: {}, blocked: blockedSet() });
  return { set, report, plan: planCopilotSync(report.desired, set.copilot, readLock(set.paths.lockFile), set.paths) };
}

function setup(t: import("node:test").TestContext) {
  const home = tmpDir(t);
  writeTree(home, {
    ".claude.json": { mcpServers: { alpha: { command: "alpha-server" }, beta: { command: "beta-server", args: ["1"] } } },
    ".copilot/mcp-config.json": USER_TEXT,
  });
  return home;
}

test("preview does not touch any file and shows a unified diff", async (t) => {
  const home = setup(t);
  const file = path.join(home, ".copilot", "mcp-config.json");
  const before = fs.readFileSync(file, "utf8");
  const { plan: p } = await plan(home);
  assert.equal(p.changed, true);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.ok(!fs.existsSync(path.join(home, ".copilot", "mcp-unison.lock.json")));
  const diff = unifiedDiff(p.oldText ?? "", p.newText, "a", "b");
  assert.match(diff, /^--- a\n\+\+\+ b\n@@ /);
  assert.match(diff, /\+ {4}"alpha": \{/);
});

test("write adds only managed entries and keeps user bytes, comments and other keys", async (t) => {
  const home = setup(t);
  const file = path.join(home, ".copilot", "mcp-config.json");
  const { plan: p } = await plan(home);
  applyCopilotSync(p);
  const after = fs.readFileSync(file, "utf8");
  // The user's own lines are preserved byte for byte, including odd spacing and the comment.
  assert.ok(after.includes('  // my own notes, keep me\n'));
  assert.ok(after.includes('    "mine":   {"command":"mine-server",  "args":["--x"]}'));
  assert.ok(after.includes('  "trustedFolders": ["/keep/me"]\n'));
  const parsed = JSON.parse(after.replace(/^\s*\/\/.*$/m, ""));
  assert.deepEqual(Object.keys(parsed.mcpServers), ["mine", "alpha", "beta"]);
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), USER_TEXT);
  const lock = JSON.parse(fs.readFileSync(path.join(home, ".copilot", "mcp-unison.lock.json"), "utf8"));
  assert.deepEqual(Object.keys(lock.managed), ["alpha", "beta"]);
});

test("a second run reports no changes", async (t) => {
  const home = setup(t);
  applyCopilotSync((await plan(home)).plan);
  const second = await plan(home);
  assert.equal(second.plan.changed, false);
  assert.ok(second.plan.actions.every((a) => a.action === "unchanged"));
  const r = runCli(["sync-copilot", "--home", home, "--lang", "en"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no changes/);
});

test("a changed source updates its managed entry and a removed source deletes it", async (t) => {
  const home = setup(t);
  applyCopilotSync((await plan(home)).plan);
  writeTree(home, { ".claude.json": { mcpServers: { alpha: { command: "alpha-server-v2" } } } });
  const { plan: p } = await plan(home);
  assert.deepEqual(
    p.actions.map((a) => [a.name, a.action]).sort(),
    [["alpha", "update"], ["beta", "remove"]],
  );
  applyCopilotSync(p);
  const parsed = JSON.parse(fs.readFileSync(path.join(home, ".copilot", "mcp-config.json"), "utf8").replace(/^\s*\/\/.*$/m, ""));
  assert.deepEqual(Object.keys(parsed.mcpServers), ["mine", "alpha"]);
  assert.equal(parsed.mcpServers.alpha.command, "alpha-server-v2");
});

test("a managed entry edited by hand is a conflict and is not overwritten or deleted", async (t) => {
  const home = setup(t);
  applyCopilotSync((await plan(home)).plan);
  const file = path.join(home, ".copilot", "mcp-config.json");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("alpha-server", "hand-edited"));
  writeTree(home, { ".claude.json": { mcpServers: { alpha: { command: "alpha-server-v3" } } } });
  const r = runCli(["sync-copilot", "--write", "--home", home, "--lang", "en"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /CONFLICT/);
  assert.ok(fs.readFileSync(file, "utf8").includes("hand-edited"));
  // beta was removed from the source, so it is still cleaned up.
  assert.ok(!fs.readFileSync(file, "utf8").includes("beta-server"));
});

test("a user entry with the same name is kept and never adopted into the lock", async (t) => {
  const home = tmpDir(t);
  writeTree(home, {
    ".claude.json": { mcpServers: { mine: { command: "different-server" } } },
    ".copilot/mcp-config.json": USER_TEXT,
  });
  const { plan: p } = await plan(home);
  assert.equal(p.actions.find((a) => a.name === "mine")?.action, "kept-user");
  assert.equal(p.changed, false);
  assert.ok(p.warnings.some((w) => w.code === "W_COPILOT_ENTRY_EXISTS"));
});

test("a missing Copilot file is created", async (t) => {
  const home = tmpDir(t);
  writeTree(home, { ".claude.json": { mcpServers: { alpha: { command: "a" } } } });
  const { plan: p } = await plan(home);
  const written = applyCopilotSync(p);
  assert.equal(written.length, 2);
  assert.ok(!fs.existsSync(path.join(home, ".copilot", "mcp-config.json.bak")));
  const parsed = JSON.parse(fs.readFileSync(path.join(home, ".copilot", "mcp-config.json"), "utf8"));
  assert.equal(parsed.mcpServers.alpha.command, "a");
});

test("sources are never modified (content and mtime)", async (t) => {
  const { home, project } = copyDemo(t);
  const files = [
    path.join(home, ".claude.json"),
    path.join(home, ".codex", "config.toml"),
    path.join(project, ".mcp.json"),
    path.join(project, ".vscode", "mcp.json"),
  ];
  const old = new Date(2020, 0, 1);
  for (const f of files) fs.utimesSync(f, old, old);
  const snap = files.map((f) => [fs.readFileSync(f, "utf8"), fs.statSync(f).mtimeMs]);
  const r = runCli(["sync-copilot", "--write", "--home", home, "--project", project]);
  assert.equal(r.status, 0, r.stderr);
  files.forEach((f, i) => {
    assert.equal(fs.readFileSync(f, "utf8"), snap[i][0]);
    assert.equal(fs.statSync(f).mtimeMs, snap[i][1]);
  });
});

test("textdiff gives an empty string for equal input and hunks for a change", () => {
  assert.equal(unifiedDiff("a\nb\n", "a\nb\n", "x", "y"), "");
  const d = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "x", "y");
  assert.equal(d, "--- x\n+++ y\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
});
