// Runs inside the real extension host (loaded by run.ts). Throws on failure.
import * as assert from "node:assert/strict";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension("leegyeongpil.mcp-unison");
  assert.ok(ext, "extension is installed in the test host");
  await ext.activate();
  const commands = await vscode.commands.getCommands(true);
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
  // The drift report command opens a document that lists the demo servers.
  await vscode.commands.executeCommand("mcpUnison.showDrift");
  const doc = vscode.window.activeTextEditor?.document;
  assert.ok(doc?.getText().includes("my-own"), "drift report mentions my-own");
}
