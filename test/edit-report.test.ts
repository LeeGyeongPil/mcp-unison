import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { editEntry } from "../src/core/targets/copilot";
import { commandOnPath, pathWarnings } from "../src/ext/report";
import { claudeEntryToSpec } from "../src/core/readers/claude";
import { tmpDir } from "./helpers";

const E = { command: "x" };

test("editEntry creates the structure when the file has no mcpServers", () => {
  assert.equal(
    editEntry('{\n  "other": 1\n}\n', "a", E),
    '{\n  "other": 1,\n  "mcpServers": {\n    "a": {\n      "command": "x"\n    }\n  }\n}\n',
  );
  assert.equal(editEntry("{}\n", "a", E), '{\n  "mcpServers": {\n    "a": {\n      "command": "x"\n    }\n  }\n}\n');
});

test("editEntry fills an empty mcpServers object and keeps what follows", () => {
  const out = editEntry('{\n  "mcpServers": {},\n  "z": [1]\n}\n', "a", E);
  assert.deepEqual(JSON.parse(out), { mcpServers: { a: E }, z: [1] });
  assert.ok(out.endsWith('  "z": [1]\n}\n'));
});

test("editEntry removes first, middle, last and only entries cleanly", () => {
  const base = '{\n  "mcpServers": {\n    "a": {"c":1},\n    "b": {"c":2},\n    "d": {"c":3}\n  }\n}\n';
  assert.deepEqual(JSON.parse(editEntry(base, "a", undefined)).mcpServers, { b: { c: 2 }, d: { c: 3 } });
  assert.deepEqual(JSON.parse(editEntry(base, "b", undefined)).mcpServers, { a: { c: 1 }, d: { c: 3 } });
  assert.deepEqual(JSON.parse(editEntry(base, "d", undefined)).mcpServers, { a: { c: 1 }, b: { c: 2 } });
  const one = '{\n  "mcpServers": {\n    "a": {"c":1}\n  }\n}\n';
  assert.deepEqual(JSON.parse(editEntry(one, "a", undefined)), { mcpServers: {} });
  // Removing a name that is not there changes nothing.
  assert.equal(editEntry(base, "nope", undefined), base);
});

test("editEntry replaces only the value of an existing entry", () => {
  const base = '{\n  "mcpServers": {\n    "a": {"c":1},   // note\n    "b": {"c":2}\n  }\n}\n';
  const out = editEntry(base, "a", { c: 9 });
  assert.ok(out.includes("// note"));
  assert.deepEqual(JSON.parse(out.replace("// note", "")).mcpServers.a, { c: 9 });
  assert.ok(out.includes('"b": {"c":2}'));
});

test("editEntry rejects a file whose top level is not an object", () => {
  assert.throws(() => editEntry("[1]", "a", E), /top level is not a JSON object/);
});

test("commandOnPath finds executables on PATH and by path, without running them", (t) => {
  const dir = tmpDir(t);
  const bin = path.join(dir, "my-tool");
  fs.writeFileSync(bin, "#!/bin/sh\n");
  assert.equal(commandOnPath("my-tool", dir, "linux"), true);
  assert.equal(commandOnPath("my-tool", "/nonexistent", "linux"), false);
  assert.equal(commandOnPath(bin, undefined, "linux"), true);
});

test("pathWarnings flags a missing command but ignores http servers and variable commands", () => {
  const specs = [
    claudeEntryToSpec("gone", { command: "definitely-not-installed-xyz" }, "claude-user"),
    claudeEntryToSpec("var", { command: "${TOOL}" }, "claude-user"),
    claudeEntryToSpec("web", { type: "http", url: "https://x.invalid" }, "claude-user"),
  ];
  const w = pathWarnings(specs, "/nonexistent", "linux");
  assert.deepEqual(w.map((x) => [x.code, x.server]), [["W_COMMAND_NOT_ON_PATH", "gone"]]);
});
