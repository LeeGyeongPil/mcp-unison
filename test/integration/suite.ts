// Runs inside the real extension host (loaded by run.ts). Throws on failure.
// Each step prints a line, so the CI log shows how far the test got.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vscode from "vscode";

function step(line: string): void {
  console.log(`[integration] ${line}`);
}

/** Fails with a clear message instead of hanging when the editor never answers. */
async function within<T>(seconds: number, what: string, work: Thenable<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer within ${seconds} s`)), seconds * 1000);
  });
  try {
    return await Promise.race([Promise.resolve(work), limit]);
  } finally {
    clearTimeout(timer);
  }
}

export async function run(): Promise<void> {
  // run.ts made a copy of the practice home. The extension reads HOME each time it looks at
  // the sources, so pointing HOME at the copy here is enough; the editor itself is unaffected.
  const home = process.env.MCP_UNISON_TEST_HOME;
  assert.ok(home && fs.existsSync(home), `MCP_UNISON_TEST_HOME should name the practice home copy (got ${home})`);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CODEX_HOME;
  delete process.env.COPILOT_HOME;
  step(`VS Code ${vscode.version}, workspace ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "(none)"}`);

  const ext = vscode.extensions.getExtension("leegyeongpil.mcp-unison");
  assert.ok(ext, "extension is installed in the test host");
  await within(60, "activating the extension", ext.activate());
  step("extension activated");

  const commands = await within(30, "listing commands", vscode.commands.getCommands(true));
  for (const id of [
    "mcpUnison.refresh",
    "mcpUnison.syncCopilot",
    "mcpUnison.showDrift",
    "mcpUnison.exportClaude",
    "mcpUnison.showInCopilotSessions",
    "mcpUnison.chooseLanguage",
  ]) {
    assert.ok(commands.includes(id), `command ${id} is registered`);
  }
  step("all 6 commands are registered");

  // The drift report command opens a markdown document and also returns it.
  const doc = await within(
    60,
    "mcpUnison.showDrift",
    vscode.commands.executeCommand<vscode.TextDocument | undefined>("mcpUnison.showDrift"),
  );
  assert.ok(doc, "showDrift returned no document (a source file in the practice home could not be read)");
  assert.equal(doc.languageId, "markdown");
  const text = doc.getText();
  for (const name of ["my-own", "files", "proxy-api"]) {
    assert.ok(text.includes(`| ${name} |`), `drift report should list ${name}:\n${text}`);
  }
  step("drift report lists the practice servers");
}
