import * as assert from "node:assert/strict";
import { test } from "node:test";
import { parse as parseToml } from "smol-toml";
import { SourceError } from "../src/core/model";
import { claudeEntryToSpec, parseClaudeJson } from "../src/core/readers/claude";
import { codexToSpecs } from "../src/core/readers/codex";
import { toCopilotEntries } from "../src/core/targets/copilot";
import { toProviderDefs } from "../src/core/targets/provider";
import { blockedSet } from "../src/core/vars";
import { runCli, tmpDir, writeTree } from "./helpers";

const blocked = blockedSet();

test("an entry with url but no type is skipped, not guessed as http", () => {
  const s = claudeEntryToSpec("x", { url: "https://x.invalid/mcp" }, "claude-user");
  assert.equal(s.skipped, "W_URL_WITHOUT_TYPE");
});

test("streamable-http is the same as http", () => {
  const s = claudeEntryToSpec("x", { type: "streamable-http", url: "https://x.invalid" }, "claude-user");
  assert.equal(s.transport, "http");
  assert.equal(s.skipped, undefined);
});

test("sse is skipped by the provider but written to Copilot with a deprecation warning", () => {
  const s = claudeEntryToSpec("old", { type: "sse", url: "https://x.invalid/sse" }, "claude-user");
  const provider = toProviderDefs([s], {}, { blocked });
  assert.equal(provider.defs.length, 0);
  assert.ok(provider.warnings.some((w) => w.code === "W_SSE_UNSUPPORTED"));
  const d = toCopilotEntries([s], blocked);
  assert.equal(d.entries.get("old")?.type, "sse");
  assert.ok(d.warnings.some((w) => w.code === "W_SSE_DEPRECATED"));
});

test("ws, sdk and headersHelper entries are skipped", () => {
  assert.equal(claudeEntryToSpec("a", { type: "ws", url: "wss://x" }, "claude-user").skipped, "W_TRANSPORT_UNSUPPORTED");
  assert.equal(claudeEntryToSpec("b", { type: "sdk", name: "b" }, "claude-user").skipped, "W_TRANSPORT_UNSUPPORTED");
  const h = claudeEntryToSpec("c", { type: "http", url: "https://x.invalid", headersHelper: "./get-headers.sh" }, "claude-user");
  assert.equal(h.skipped, "W_HEADERS_HELPER");
  const provider = toProviderDefs([h], {}, { blocked });
  assert.equal(provider.defs.length, 0);
});

test("oauth.clientId is carried over and other oauth fields are reported", () => {
  const s = claudeEntryToSpec(
    "o",
    { type: "http", url: "https://x.invalid", oauth: { clientId: "cid", callbackPort: 8080 } },
    "claude-user",
  );
  assert.equal(s.oauthClientId, "cid");
  assert.ok(s.warnings.some((w) => w.code === "W_OAUTH_PARTIAL" && w.detail === "callbackPort"));
  assert.equal(toCopilotEntries([s], blocked).entries.get("o")?.oauthClientId, "cid");
});

test("Codex env_vars, bearer_token_env_var, env_http_headers, enabled and cwd map across", () => {
  const toml = `
[mcp_servers.local]
command = "node"
args = ["srv.js"]
cwd = "/work/srv"
env = { A = "1" }
env_vars = ["SEARCH_KEY"]

[mcp_servers.remote]
url = "https://codex.example.invalid/mcp"
bearer_token_env_var = "REMOTE_TOKEN"
http_headers = { "X-Static" = "yes" }
env_http_headers = { "X-Org" = "ORG_ID" }

[mcp_servers.off]
command = "off"
enabled = false
`;
  const specs = codexToSpecs(parseToml(toml));
  const by = Object.fromEntries(specs.map((s) => [s.name, s]));
  assert.deepEqual(by.local.env, { A: "1", SEARCH_KEY: "${SEARCH_KEY}" });
  assert.equal(by.local.cwd, "/work/srv");
  assert.deepEqual(by.remote.headers, {
    "X-Static": "yes",
    "X-Org": "${ORG_ID}",
    Authorization: "Bearer ${REMOTE_TOKEN}",
  });
  assert.equal(by.off.skipped, "W_DISABLED");
  // cwd survives into the live definition.
  const p = toProviderDefs([by.local], { SEARCH_KEY: "k" }, { blocked });
  const def = p.defs[0];
  assert.equal(def.kind === "stdio" && def.cwd, "/work/srv");
  assert.equal(def.kind === "stdio" && def.env.SEARCH_KEY, "k");
});

test("a Codex server keeps ordinary credential variables (the block rule is Claude's)", () => {
  const specs = codexToSpecs(parseToml('[mcp_servers.r]\nurl = "https://x.invalid"\nbearer_token_env_var = "NPM_TOKEN"\n'));
  const p = toProviderDefs(specs, { NPM_TOKEN: "tok" }, { blocked });
  const def = p.defs[0];
  assert.equal(def.kind === "http" && def.headers.Authorization, "Bearer tok");
});

test("invalid JSON names the file and the line", () => {
  assert.throws(
    () => parseClaudeJson('{\n  "mcpServers": {\n    "a": }\n}', "/home/me/.claude.json", undefined),
    (err: unknown) => err instanceof SourceError && err.message.includes("/home/me/.claude.json") && /line 3/.test(err.message),
  );
});

test("the CLI exits 2 and prints the broken file path", (t) => {
  const home = tmpDir(t);
  writeTree(home, { ".claude.json": "{ not json" });
  const r = runCli(["list", "--home", home, "--lang", "en"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes(`${home}/.claude.json`), r.stderr);
});

test("the CLI exits 2 for broken Codex TOML and names the file", (t) => {
  const home = tmpDir(t);
  writeTree(home, { ".codex/config.toml": "[mcp_servers.a\ncommand = " });
  const r = runCli(["list", "--home", home]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("config.toml"), r.stderr);
});
