// Runs the real-editor suite (test/integration/suite.ts) against the `vscode` stand-in, so the
// suite's own logic is checked on every `npm test` and not only in CI under xvfb.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { ROOT, copyDemo } from "./helpers";
import { createShim, installShim } from "./vscode-shim";

const ENV_KEYS = ["HOME", "USERPROFILE", "CODEX_HOME", "COPILOT_HOME", "MCP_UNISON_TEST_HOME", "LOG_LEVEL", "GITHUB_TOKEN"];

test("the real-editor suite passes against the stand-in, with the extension id from package.json", async (t) => {
  const shim = createShim();
  const restore = installShim(shim);
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const subscriptions: { dispose(): void }[] = [];
  t.after(() => {
    for (const s of subscriptions) s.dispose();
    restore();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  for (const k of ENV_KEYS) delete process.env[k];

  // What run.ts does before it starts the editor: a practice home copy, opened on its project.
  const { home, project } = copyDemo(t);
  process.env.MCP_UNISON_TEST_HOME = home;
  shim.folders = [{ uri: { fsPath: project } }];

  // The real editor names an extension "<publisher>.<name>"; the suite must ask for exactly that.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  shim.extension = {
    id: `${pkg.publisher}.${pkg.name}`,
    isActive: false,
    activate: async () => {
      require("../src/extension").activate({ subscriptions });
      shim.extension!.isActive = true;
    },
  };

  const suite: typeof import("./integration/suite") = require("./integration/suite");
  await suite.run();
  assert.equal(shim.extension.isActive, true);
  assert.equal(process.env.HOME, home, "the suite points HOME at the practice home");
});
