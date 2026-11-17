import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { exportToClaude } from "../src/core/targets/claude";
import { copyDemo, runCli } from "./helpers";

const VSCODE_JSONC = `{
  // comment that must not break parsing
  "inputs": [{ "id": "token", "type": "promptString" }],
  "servers": {
    "envy": {
      "command": "node",
      "args": ["\${workspaceFolder}/srv.js", "--name=it's"],
      "env": { "BASE": "\${env:API_BASE}" },
      "envFile": "\${workspaceFolder}/.env", /* trailing comment */
    },
    "needs-input": {
      "type": "http",
      "url": "https://x.invalid/mcp",
      "headers": { "Authorization": "Bearer \${input:token}" }
    },
    "web": { "type": "http", "url": "https://web.invalid/mcp", "headers": { "X-Key": "\${env:WEB_KEY}" } }
  }
}
`;

const opts = { workspaceFolder: "/ws/app", userHome: "/home/me" };

test("\${env:X} becomes \${X} and \${workspaceFolder} becomes an absolute path", () => {
  const r = exportToClaude(VSCODE_JSONC, "mcp.json", { ...opts, format: "mcp-json" });
  const out = JSON.parse(r.text).mcpServers;
  assert.equal(out.envy.env.BASE, "${API_BASE}");
  assert.deepEqual(out.envy.args, ["/ws/app/srv.js", "--name=it's"]);
  assert.equal(out.web.headers["X-Key"], "${WEB_KEY}");
  assert.ok(r.warnings.some((w) => w.code === "W_RESOLVED_PATH" && w.server === "envy"));
  assert.ok(r.warnings.some((w) => w.code === "W_DROPPED_FIELD" && w.field === "envFile"));
});

test("a server that needs \${input:...} is excluded with W_INPUT_VAR", () => {
  const r = exportToClaude(VSCODE_JSONC, "mcp.json", { ...opts, format: "mcp-json" });
  assert.deepEqual(r.excluded, ["needs-input"]);
  assert.ok(!r.text.includes("needs-input"));
  const w = r.warnings.find((x) => x.code === "W_INPUT_VAR");
  assert.equal(w?.server, "needs-input");
  assert.equal(w?.detail, "${input:token}");
});

test("add-json lines pass only the inner object and escape single quotes", () => {
  const r = exportToClaude(VSCODE_JSONC, "mcp.json", { ...opts, format: "add-json" });
  const lines = r.text.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(
    lines[0],
    `claude mcp add-json envy '{"type":"stdio","command":"node","args":["/ws/app/srv.js","--name=it'\\''s"],"env":{"BASE":"\${API_BASE}"}}'`,
  );
  assert.equal(
    lines[1],
    `claude mcp add-json web '{"type":"http","url":"https://web.invalid/mcp","headers":{"X-Key":"\${WEB_KEY}"}}'`,
  );
});

test("the CLI exports the demo project and warns about input variables", (t) => {
  const { home, project } = copyDemo(t);
  const r = runCli(["export-claude", "--format", "add-json", "--home", home, "--project", project, "--lang", "en"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith("claude mcp add-json vs-env '"));
  assert.ok(r.stdout.includes(path.join(project, "server.js")));
  assert.match(r.stderr, /W_INPUT_VAR/);
  assert.match(r.stderr, /vs-only/);
});

test("export-claude without a .vscode/mcp.json explains how to fix it", (t) => {
  const { home } = copyDemo(t);
  const r = runCli(["export-claude", "--home", home, "--project", home, "--lang", "en"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Create \.vscode\/mcp\.json/);
});
