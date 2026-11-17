import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { ROOT, copyDemo, tmpDir } from "./helpers";
import { createShim, installShim } from "./vscode-shim";

const shim = createShim();
const restore = installShim(shim);
// The extension reads process.env. Variables the demo refers to are cleared too, so a machine
// (or CI runner) that happens to export GITHUB_TOKEN or LOG_LEVEL sees the same result.
const ENV_KEYS = ["HOME", "CODEX_HOME", "COPILOT_HOME", "GITHUB_TOKEN", "SEARCH_API_KEY", "LOG_LEVEL", "API_BASE", "NPM_TOKEN"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const subscriptions: { dispose(): void }[] = [];
let home = "";
let project = "";
// eslint-disable-next-line @typescript-eslint/no-require-imports
let ext: typeof import("../src/extension");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function defs(): Promise<any[]> {
  const provider = shim.providers.get("mcpUnison.servers");
  return (await provider.provideMcpServerDefinitions({})) as any[];
}

const cleanups: (() => void)[] = [];

before(() => {
  // The shim run uses a fake home: the real one is never read.
  const demo = copyDemo({ after: (fn) => cleanups.push(fn) });
  home = demo.home;
  project = demo.project;
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HOME = home;
  shim.folders = [{ uri: { fsPath: project } }];
  shim.config.debounceMs = 120;
  shim.config.pollMs = 50;
  ext = require("../src/extension");
  ext.activate({ subscriptions } as never);
});

after(() => {
  for (const s of subscriptions) s.dispose();
  restore();
  for (const fn of cleanups) fn();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("activate registers one provider whose id matches package.json", () => {
  const ids = pkg.contributes.mcpServerDefinitionProviders.map((p: { id: string }) => p.id);
  assert.equal(ids.length, 1);
  assert.equal(ext.PROVIDER_ID, ids[0]);
  assert.deepEqual([...shim.providers.keys()], ids);
});

test("all six commands are registered and declared in package.json", () => {
  const declared = pkg.contributes.commands.map((c: { command: string }) => c.command).sort();
  assert.equal(declared.length, 6);
  assert.deepEqual([...shim.commands.keys()].sort(), declared);
  assert.deepEqual([...ext.COMMAND_IDS].sort(), declared);
});

test("the demo home yields only the servers that can really be offered", async () => {
  const list = await defs();
  const names = list.map((d) => d.label).sort();
  // Skipped: legacy-sse (SSE), bad-url, old (disabled), github and search (unset variables).
  // Hidden because the editor already sees them: docs (Copilot config), lint (workspace .mcp.json).
  assert.deepEqual(names, ["files", "proxy-api"]);
  const files = list.find((d) => d.label === "files");
  assert.equal(files.command, "node");
  assert.deepEqual(files.args, ["server.js"]);
  assert.deepEqual(files.env, { LEVEL: "info" });
  const proxy = list.find((d) => d.label === "proxy-api");
  assert.equal(proxy.uri.toString(), "https://api.example.invalid/mcp");
  assert.deepEqual(proxy.headers, { "X-Registry-Token": "" });
});

test("version is stable for the same input", async () => {
  const a = await defs();
  const b = await defs();
  assert.deepEqual(a.map((d) => d.version), b.map((d) => d.version));
  assert.ok(a.every((d) => /^[0-9a-f]{12}$/.test(d.version)));
});

test("changing one source changes only that server version and fires one debounced event", async () => {
  const provider = shim.providers.get("mcpUnison.servers");
  const before = Object.fromEntries((await defs()).map((d) => [d.label, d.version]));
  let fired = 0;
  const sub = provider.onDidChangeMcpServerDefinitions(() => fired++);

  const claudeJson = path.join(home, ".claude.json");
  const text = JSON.parse(fs.readFileSync(claudeJson, "utf8"));
  const key = Object.keys(text.projects)[0];
  text.projects[key].mcpServers.files.args = ["server-v2.js"];
  // Two quick writes must collapse into a single event.
  fs.writeFileSync(claudeJson, JSON.stringify(text, null, 2));
  await sleep(30);
  fs.writeFileSync(claudeJson, JSON.stringify(text, null, 2) + "\n");
  await sleep(900);

  assert.equal(fired, 1);
  const after = Object.fromEntries((await defs()).map((d) => [d.label, d.version]));
  assert.notEqual(after.files, before.files);
  assert.equal(after["proxy-api"], before["proxy-api"]);

  // A change that does not affect any offered definition fires nothing.
  text.numStartups = 99;
  fs.writeFileSync(claudeJson, JSON.stringify(text, null, 2));
  await sleep(700);
  assert.equal(fired, 1);
  sub.dispose();
});

test("Sync to Copilot config shows a diff, asks, then writes only on Apply", async () => {
  const file = path.join(home, ".copilot", "mcp-config.json");
  const before = fs.readFileSync(file, "utf8");
  shim.answers.message = undefined;
  await shim.commands.get("mcpUnison.syncCopilot")!();
  assert.equal(shim.diffs.length, 1);
  assert.equal(fs.readFileSync(file, "utf8"), before, "cancelled prompt must not write");

  shim.answers.message = "Apply";
  await shim.commands.get("mcpUnison.syncCopilot")!();
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(written.mcpServers.files);
  assert.ok(written.mcpServers["my-own"]);
  shim.answers.message = undefined;

  // Now the Copilot config holds the servers, so the provider stops offering them (no duplicates).
  assert.deepEqual((await defs()).map((d) => d.label), []);
});

test("Show drift report opens a markdown document", async () => {
  const returned = await shim.commands.get("mcpUnison.showDrift")!();
  const doc = shim.documents.at(-1)!;
  assert.equal(returned, doc, "the command returns the document it opened");
  assert.equal(doc.language, "markdown");
  assert.match(doc.content, /# MCP Unison drift report/);
  assert.match(doc.content, /\| my-own \|/);
});

test("Export opens the converted servers in an untitled document", async () => {
  shim.answers.quickPick = "add-json";
  await shim.commands.get("mcpUnison.exportClaude")!();
  const doc = shim.documents.at(-1)!;
  assert.equal(doc.language, "shellscript");
  assert.ok(doc.content.startsWith("claude mcp add-json vs-env '"));
  assert.match(doc.content, /# W_INPUT_VAR vs-only/);
});

test("Choose Language stores the selection in the setting and the UI language follows", async () => {
  shim.answers.quickPick = { label: "한국어", value: "ko" };
  await shim.commands.get("mcpUnison.chooseLanguage")!();
  assert.deepEqual(shim.updates.at(-1), { key: "language", value: "ko", target: 1 });
  await shim.commands.get("mcpUnison.showInCopilotSessions")!();
  assert.match(shim.messages.at(-1)!.text, /MCP: List Servers/);
  assert.match(shim.messages.at(-1)!.text, /Copilot 세션/);

  shim.answers.quickPick = { label: "English", value: "en" };
  await shim.commands.get("mcpUnison.chooseLanguage")!();
  assert.deepEqual(shim.updates.at(-1), { key: "language", value: "en", target: 1 });
  await shim.commands.get("mcpUnison.showInCopilotSessions")!();
  assert.match(shim.messages.at(-1)!.text, /so Copilot sessions pick up/);
});

test("with no workspace folder the provider still answers from user scope", async (t) => {
  const bare = tmpDir(t);
  fs.writeFileSync(path.join(bare, ".claude.json"), JSON.stringify({ mcpServers: { solo: { command: "solo-server" } } }));
  const savedHome = process.env.HOME;
  const savedFolders = shim.folders;
  process.env.HOME = bare;
  shim.folders = [];
  try {
    assert.deepEqual((await defs()).map((d) => d.label), ["solo"]);
  } finally {
    process.env.HOME = savedHome;
    shim.folders = savedFolders;
  }
});

/** Runs a command and fails (instead of hanging) if it does not finish within 3 seconds. */
async function finishes(id: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${id} did not finish within 3 s`)), 3000);
  });
  try {
    return await Promise.race([shim.commands.get(id)!(), limit]);
  } finally {
    clearTimeout(timer);
  }
}

test("commands that only show a notification finish without waiting for it to be closed", async () => {
  await finishes("mcpUnison.refresh");
  await finishes("mcpUnison.showInCopilotSessions");
  assert.match(shim.messages.at(-1)!.text, /MCP: List Servers/);
});

test("a broken source file shows an error notification and the command still finishes", async () => {
  const claudeJson = path.join(home, ".claude.json");
  const good = fs.readFileSync(claudeJson, "utf8");
  fs.writeFileSync(claudeJson, "{ broken");
  try {
    assert.equal(await finishes("mcpUnison.showDrift"), undefined);
    const last = shim.messages.at(-1)!;
    assert.equal(last.kind, "error");
    assert.ok(last.text.includes(".claude.json"), last.text);
  } finally {
    fs.writeFileSync(claudeJson, good);
  }
});
