// Starts a real VS Code with the extension loaded. CI only (needs a display, for example xvfb).
// Locally: npm run test:integration (not part of `npm test`).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const root = path.resolve(__dirname, "..", "..", "..");
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-unison-it-"));
  fs.cpSync(path.join(root, "examples", "demo-home"), fakeHome, { recursive: true });
  const claude = path.join(fakeHome, ".claude.json");
  const project = path.join(fakeHome, "project");
  fs.writeFileSync(claude, fs.readFileSync(claude, "utf8").split("__DEMO_PROJECT__").join(project));
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, "suite"),
      // --no-sandbox: Electron's sandbox helper fails on Ubuntu 24.04 runners (AppArmor blocks user namespaces).
      launchArgs: [project, "--disable-extensions", "--no-sandbox", "--disable-gpu", "--disable-workspace-trust"],
      extensionTestsEnv: { HOME: fakeHome, USERPROFILE: fakeHome },
    });
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
