import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { copyDemo, runCli } from "./helpers";

interface Row {
  name: string;
  status: string;
  warnings: string[];
  sources: Record<string, unknown>;
}

function diffJson(home: string, project: string): Row[] {
  const r = runCli(["diff", "--json", "--home", home, "--project", project, "--lang", "en"]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).servers as Row[];
}

const status = (rows: Row[], name: string): string | undefined => rows.find((r) => r.name === name)?.status;

test("end to end: check fails, sync writes, servers become same, my-own stays, second sync is a no-op", (t) => {
  const { home, project } = copyDemo(t);
  const base = ["--home", home, "--project", project, "--lang", "en"];

  assert.equal(runCli(["diff", "--check", ...base]).status, 1);

  const before = diffJson(home, project);
  assert.equal(status(before, "docs"), "kept-user");
  assert.equal(status(before, "lint"), "native");
  assert.equal(status(before, "my-own"), "only-copilot");
  assert.equal(status(before, "bad-url"), "skipped");
  assert.equal(status(before, "old"), "skipped");
  assert.equal(status(before, "files"), "only-source");

  const write = runCli(["sync-copilot", "--write", ...base]);
  assert.equal(write.status, 0, write.stdout + write.stderr);

  const after = diffJson(home, project);
  for (const name of ["files", "github", "proxy-api", "legacy-sse", "search"]) {
    assert.equal(status(after, name), "same", name);
  }
  assert.equal(status(after, "my-own"), "only-copilot");
  assert.equal(status(after, "docs"), "kept-user"); // the user's own entry is never overwritten

  const second = runCli(["sync-copilot", ...base]);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /no changes/);

  const written = JSON.parse(fs.readFileSync(path.join(home, ".copilot", "mcp-config.json"), "utf8"));
  assert.deepEqual(written.trustedFolders, ["/example/keep-me"]);
  assert.equal(written.mcpServers["my-own"].command, "my-own-server");
  // The blocked credential variable was blanked, the ordinary one stays a reference.
  assert.equal(written.mcpServers["proxy-api"].headers["X-Registry-Token"], "");
  assert.equal(written.mcpServers.github.headers.Authorization, "Bearer ${GITHUB_TOKEN}");
});

test("--json lists every status and the warning codes", (t) => {
  const { home, project } = copyDemo(t);
  const rows = diffJson(home, project);
  const statuses = new Set(rows.map((r) => r.status));
  for (const s of ["kept-user", "native", "only-copilot", "skipped", "only-source", "only-vscode"]) {
    assert.ok(statuses.has(s), s);
  }
  assert.ok(rows.find((r) => r.name === "proxy-api")?.warnings.includes("W_BLOCKED_SECRET_VAR"));
  assert.ok(rows.find((r) => r.name === "bad-url")?.warnings.includes("W_URL_WITHOUT_TYPE"));
  assert.deepEqual(rows.find((r) => r.name === "files")?.sources, { claude: "local" });
});

test("the demo local scope wins over the user scope", (t) => {
  const { home, project } = copyDemo(t);
  const r = runCli(["list", "--json", "--home", home, "--project", project]);
  const files = JSON.parse(r.stdout).servers.find((s: { name: string }) => s.name === "files");
  assert.equal(files.origin, "claude-local");
  assert.equal(files.target, "node server.js");
});

test("--demo works on a throwaway copy and exits 0 (this is what npm start runs)", () => {
  const r = runCli(["diff", "--demo", "--lang", "en"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NAME\s+SOURCES\s+STATUS\s+NOTES/);
  assert.match(r.stdout, /proxy-api\s+claude:user\s+only-source\s+W_BLOCKED_SECRET_VAR/);
  assert.match(r.stderr, /Practice mock mode/);
});

test("--demo --write never touches the repository demo files", () => {
  const demoFile = path.join(__dirname, "..", "..", "examples", "demo-home", ".copilot", "mcp-config.json");
  const before = fs.readFileSync(demoFile, "utf8");
  const r = runCli(["sync-copilot", "--demo", "--write", "--lang", "en"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /throwaway copy/);
  assert.equal(fs.readFileSync(demoFile, "utf8"), before);
});

test("usage errors exit 2 with a fix", () => {
  assert.equal(runCli(["bogus", "--lang", "en"]).status, 2);
  const r = runCli(["list", "--nope", "--lang", "en"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option "--nope"/);
  assert.equal(runCli(["export-claude", "--format", "xml", "--lang", "en"]).status, 2);
  assert.equal(runCli(["list", "--lang", "fr"]).status, 2);
  assert.equal(runCli(["list", "--home"]).status, 2);
});

test("an empty home lists nothing without failing", (t) => {
  const { home } = copyDemo(t);
  const empty = path.join(home, "empty");
  fs.mkdirSync(empty);
  const r = runCli(["list", "--home", empty, "--lang", "en"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No servers found/);
});
