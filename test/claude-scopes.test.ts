import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { loadSources, mergeServers } from "../src/core/merge";
import { findLocalKey, normalizeProjectKey } from "../src/core/paths";
import { parseClaudeJson } from "../src/core/readers/claude";
import { ROOT, tmpDir, writeTree } from "./helpers";

const FIXTURE = fs.readFileSync(path.join(ROOT, "test", "fixtures", "claude-scopes.json"), "utf8");

test("local scope replaces the whole user entry instead of merging fields", async (t) => {
  const home = tmpDir(t);
  writeTree(home, { ".claude.json": FIXTURE });
  const set = await loadSources({ home, projectDir: "/Work/Demo", platform: "linux" });
  const { servers } = mergeServers(set);
  const shared = servers.find((s) => s.name === "shared");
  assert.equal(shared?.origin, "claude-local");
  assert.equal(shared?.command, "node");
  assert.deepEqual(shared?.args, ["local-version.js"]);
  // The user entry's env must not leak into the winning local entry.
  assert.deepEqual(shared?.env, {});
  assert.ok(servers.some((s) => s.name === "user-only" && s.origin === "claude-user"));
});

test("precedence is local > project > user", async (t) => {
  const home = tmpDir(t);
  const project = path.join(home, "proj");
  writeTree(home, {
    ".claude.json": {
      mcpServers: { a: { command: "user-a" }, b: { command: "user-b" }, c: { command: "user-c" } },
      projects: { [project]: { mcpServers: { a: { command: "local-a" } } } },
    },
    "proj/.mcp.json": { mcpServers: { a: { command: "project-a" }, b: { command: "project-b" } } },
  });
  const { servers } = mergeServers(await loadSources({ home, projectDir: project }));
  const byName = Object.fromEntries(servers.map((s) => [s.name, [s.origin, s.command]]));
  assert.deepEqual(byName.a, ["claude-local", "local-a"]);
  assert.deepEqual(byName.b, ["claude-project", "project-b"]);
  assert.deepEqual(byName.c, ["claude-user", "user-c"]);
});

test("project key normalisation: trailing slash, backslashes, case on darwin and win32", () => {
  assert.equal(normalizeProjectKey("/Work/Demo/", "linux"), "/Work/Demo");
  assert.equal(normalizeProjectKey("C:\\Work\\Demo\\", "win32"), "c:/work/demo");
  assert.equal(normalizeProjectKey("/Work/Demo", "darwin"), "/work/demo");
  assert.equal(findLocalKey(["/Work/Demo/"], "/work/demo", "darwin").key, "/Work/Demo/");
  assert.equal(findLocalKey(["C:\\Work\\Demo"], "c:/work/demo/", "win32").key, "C:\\Work\\Demo");
  // Linux paths are case sensitive.
  assert.equal(findLocalKey(["/Work/Demo/"], "/work/demo", "linux").key, undefined);
});

test("a key that does not match yields a diagnostic naming the closest key", () => {
  const parsed = parseClaudeJson(FIXTURE, "x.json", "/work/demo", "linux");
  assert.equal(parsed.local.length, 0);
  assert.equal(parsed.diagnostics.length, 1);
  assert.equal(parsed.diagnostics[0].code, "W_LOCAL_SCOPE_NOT_FOUND");
  assert.equal(parsed.diagnostics[0].detail, "/Work/Demo/");
});

test("a project without any similar key produces no diagnostic", () => {
  const parsed = parseClaudeJson(FIXTURE, "x.json", "/somewhere/totally/different", "linux");
  assert.equal(parsed.diagnostics.length, 0);
});

test("Claude wins a Claude/Codex name conflict and a warning is raised", async (t) => {
  const home = tmpDir(t);
  writeTree(home, {
    ".claude.json": { mcpServers: { docs: { command: "claude-docs" } } },
    ".codex/config.toml": '[mcp_servers.docs]\ncommand = "codex-docs"\n[mcp_servers.extra]\ncommand = "x"\n',
  });
  const r = mergeServers(await loadSources({ home }));
  assert.equal(r.servers.find((s) => s.name === "docs")?.command, "claude-docs");
  assert.equal(r.servers.find((s) => s.name === "extra")?.origin, "codex");
  const w = r.warnings.find((x) => x.code === "W_NAME_CONFLICT");
  assert.equal(w?.server, "docs");
  assert.equal(w?.detail, "claude-user");
});
