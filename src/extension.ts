import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { computeDrift, isDriftRow, type DriftReport } from "./core/drift";
import { loadSources, type SourceSet } from "./core/merge";
import { resolvePaths, type Paths } from "./core/paths";
import { exportToClaude, type ExportFormat } from "./core/targets/claude";
import { applyCopilotSync, planCopilotSync, readLock } from "./core/targets/copilot";
import { toProviderDefs, type ProviderDef, type ProviderResult } from "./core/targets/provider";
import { blockedSet } from "./core/vars";
import { resolveExtLang, sourceErrorMessage, t, warningMessage, type Lang } from "./i18n";
import { SourceError } from "./core/model";
import type { MessageKey } from "./i18n/en";
import { buildReport, pathWarnings } from "./ext/report";

/** Must equal contributes.mcpServerDefinitionProviders[0].id in package.json. */
export const PROVIDER_ID = "mcpUnison.servers";
export const DEFAULT_DEBOUNCE_MS = 500;
export const DEFAULT_POLL_MS = 1000;

export const COMMAND_IDS = [
  "mcpUnison.refresh",
  "mcpUnison.syncCopilot",
  "mcpUnison.showDrift",
  "mcpUnison.exportClaude",
  "mcpUnison.showInCopilotSessions",
  "mcpUnison.chooseLanguage",
] as const;

interface Computed {
  set: SourceSet;
  report: DriftReport;
  provider: ProviderResult;
}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("mcpUnison");
}

function lang(): Lang {
  return resolveExtLang(cfg().get<string>("language", "auto"), vscode.env.language);
}

function msg(key: MessageKey, params?: Record<string, string | number | undefined>): string {
  return t(lang(), key, params);
}

function workspaceDir(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Read every source and work out what the provider offers and how the Copilot config differs. */
async function compute(): Promise<Computed> {
  const c = cfg();
  const env = process.env;
  const set = await loadSources({
    env,
    projectDir: workspaceDir(),
    retries: 3,
    useClaude: c.get<boolean>("sources.claude", true),
    useCodex: c.get<boolean>("sources.codex", true),
  });
  const blocked = blockedSet(c.get<string[]>("blockedRemoteVars", []));
  const report = computeDrift(set, { env, blocked, lock: readLock(set.paths.lockFile) });

  // Names the editor can already see another way are not offered again (avoids duplicate tools).
  const exclude = new Map<string, string>();
  for (const n of Object.keys(set.vscode?.servers ?? {})) exclude.set(n, "vscode");
  for (const s of set.claudeProject) exclude.set(s.name, "workspace-mcp");
  for (const n of Object.keys(set.copilot?.entries ?? {})) exclude.set(n, "copilot");
  const provider = toProviderDefs(report.merged.servers, env, { blocked, excludeNames: exclude });
  return { set, report, provider };
}

function signature(defs: readonly ProviderDef[]): string {
  return JSON.stringify(defs.map((d) => [d.name, d.version]).sort());
}

function toVscodeDef(d: ProviderDef): vscode.McpServerDefinition {
  if (d.kind === "stdio") {
    const def = new vscode.McpStdioServerDefinition(d.name, d.command, d.args, d.env, d.version);
    if (d.cwd) def.cwd = vscode.Uri.file(d.cwd);
    return def;
  }
  return new vscode.McpHttpServerDefinition(d.name, vscode.Uri.parse(d.url), d.headers, d.version);
}

function watchFiles(home: Paths): string[] {
  const files = [home.claudeJson, home.codexConfig, home.copilotConfig];
  const ws = workspaceDir();
  if (ws) files.push(path.join(ws, ".mcp.json"), path.join(ws, ".vscode", "mcp.json"));
  return files;
}

export function activate(context: vscode.ExtensionContext): void {
  const changed = new vscode.EventEmitter<void>();
  let lastSignature: string | undefined;
  let lastNotifiedDrift = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watched: { file: string; listener: (cur: fs.Stats, prev: fs.Stats) => void }[] = [];
  let disposed = false;

  const provider: vscode.McpServerDefinitionProvider = {
    onDidChangeMcpServerDefinitions: changed.event,
    // File reading starts here, not at activation, so an empty workspace stays cheap.
    provideMcpServerDefinitions: async () => {
      const c = await compute();
      lastSignature = signature(c.provider.defs);
      return c.provider.defs.map(toVscodeDef);
    },
    resolveMcpServerDefinition: async (server) => server,
  };
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, provider));
  context.subscriptions.push(changed);

  async function onSourcesChanged(): Promise<void> {
    if (disposed) return;
    let c: Computed;
    try {
      c = await compute();
    } catch {
      return; // half-written or invalid file: wait for the next change
    }
    const sig = signature(c.provider.defs);
    if (lastSignature !== undefined && sig !== lastSignature) changed.fire();
    lastSignature = sig;

    const mode = cfg().get<string>("copilotSync", "ask");
    const drifting = c.report.rows.filter(isDriftRow).length;
    if (mode === "ask" && drifting > 0 && drifting !== lastNotifiedDrift) {
      lastNotifiedDrift = drifting;
      const pick = await vscode.window.showInformationMessage(msg("ext.driftNotice", { count: drifting }), msg("ext.review"));
      if (pick === msg("ext.review")) await vscode.commands.executeCommand("mcpUnison.syncCopilot");
    } else if (mode === "auto") {
      const plan = planCopilotSync(c.report.desired, c.set.copilot, readLock(c.set.paths.lockFile), c.set.paths);
      if (plan.changed) applyCopilotSync(plan);
    }
    if (drifting === 0) lastNotifiedDrift = 0;
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    const delay = cfg().get<number>("debounceMs", DEFAULT_DEBOUNCE_MS);
    timer = setTimeout(() => {
      timer = undefined;
      void onSourcesChanged();
    }, delay);
  }

  // fs.watchFile polls with stat(). Unlike fs.watch it also works for files that do not
  // exist yet and where OS watch handles are limited; five files cost next to nothing.
  function clearWatchers(): void {
    for (const w of watched) fs.unwatchFile(w.file, w.listener);
    watched = [];
  }

  function setupWatchers(): void {
    clearWatchers();
    const interval = cfg().get<number>("pollMs", DEFAULT_POLL_MS);
    for (const file of watchFiles(resolvePaths({ env: process.env }))) {
      const listener = (cur: fs.Stats, prev: fs.Stats): void => {
        if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) schedule();
      };
      fs.watchFile(file, { interval, persistent: false }, listener);
      watched.push({ file, listener });
    }
  }

  setupWatchers();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => setupWatchers()));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("mcpUnison")) schedule();
    }),
  );
  context.subscriptions.push({
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      clearWatchers();
    },
  });

  const reg = (id: (typeof COMMAND_IDS)[number], fn: () => unknown): void => {
    const guarded = async (): Promise<unknown> => {
      try {
        return await fn();
      } catch (err) {
        // A broken source file is reported in the chosen language instead of a raw error.
        if (!(err instanceof SourceError)) throw err;
        // Not awaited: a notification without buttons settles only when the user closes it,
        // so awaiting it would leave executeCommand callers (and the real-editor test) waiting.
        void vscode.window.showErrorMessage(sourceErrorMessage(lang(), err));
        return undefined;
      }
    };
    context.subscriptions.push(vscode.commands.registerCommand(id, guarded));
  };

  reg("mcpUnison.refresh", async () => {
    changed.fire();
    // Notifications without buttons are not awaited: they settle only when the user closes them.
    void vscode.window.showInformationMessage(msg("ext.refreshed"));
  });

  reg("mcpUnison.syncCopilot", async () => {
    const c = await compute();
    const plan = planCopilotSync(c.report.desired, c.set.copilot, readLock(c.set.paths.lockFile), c.set.paths);
    if (!plan.changed) {
      if (plan.conflicts.length > 0) {
        void vscode.window.showWarningMessage(msg("ext.conflicts", { names: plan.conflicts.join(", ") }));
      } else {
        void vscode.window.showInformationMessage(msg("ext.noChanges"));
      }
      return;
    }
    // The proposed text goes to a temp file so the built-in diff editor can compare it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-unison-"));
    try {
      const proposed = path.join(dir, "mcp-config.proposed.json");
      fs.writeFileSync(proposed, plan.newText, "utf8");
      let original = plan.file;
      if (plan.oldText === null) {
        original = path.join(dir, "mcp-config.current.json");
        fs.writeFileSync(original, "", "utf8");
      }
      await vscode.commands.executeCommand(
        "vscode.diff",
        vscode.Uri.file(original),
        vscode.Uri.file(proposed),
        "MCP Unison: " + path.basename(plan.file),
      );
      const count = plan.actions.filter((a) => a.action === "add" || a.action === "update" || a.action === "remove").length;
      const apply = msg("ext.apply");
      const pick = await vscode.window.showInformationMessage(
        msg("ext.syncPrompt", { count, file: plan.file }),
        { modal: true },
        apply,
      );
      if (pick === apply) {
        applyCopilotSync(plan);
        void vscode.window.showInformationMessage(msg("ext.applied"));
        if (plan.conflicts.length > 0) {
          void vscode.window.showWarningMessage(msg("ext.conflicts", { names: plan.conflicts.join(", ") }));
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  reg("mcpUnison.showDrift", async () => {
    const c = await compute();
    const extra = pathWarnings(c.report.merged.servers, process.env.PATH);
    const doc = await vscode.workspace.openTextDocument({
      content: buildReport(lang(), c.report, extra),
      language: "markdown",
    });
    await vscode.window.showTextDocument(doc);
    // Returned so callers of executeCommand (the real-editor test) can read the report directly.
    return doc;
  });

  reg("mcpUnison.exportClaude", async () => {
    const ws = workspaceDir();
    if (!ws) {
      void vscode.window.showWarningMessage(msg("ext.noWorkspace"));
      return;
    }
    const file = path.join(ws, ".vscode", "mcp.json");
    if (!fs.existsSync(file)) {
      void vscode.window.showWarningMessage(msg("ext.noVscodeFile"));
      return;
    }
    const formatPick = await vscode.window.showQuickPick(["add-json", "mcp-json"], { placeHolder: "claude mcp add-json / .mcp.json" });
    if (!formatPick) return;
    const result = exportToClaude(fs.readFileSync(file, "utf8"), file, {
      format: formatPick as ExportFormat,
      workspaceFolder: ws,
      userHome: os.homedir(),
    });
    const l = lang();
    let content = result.text;
    if (formatPick === "add-json" && result.warnings.length > 0) {
      content += result.warnings.map((w) => `# ${w.code} ${w.server}: ${warningMessage(l, w)}`).join("\n") + "\n";
    }
    const doc = await vscode.workspace.openTextDocument({
      content,
      language: formatPick === "add-json" ? "shellscript" : "json",
    });
    await vscode.window.showTextDocument(doc);
    if (formatPick === "mcp-json" && result.warnings.length > 0) {
      void vscode.window.showWarningMessage(result.warnings.map((w) => `${w.code} ${w.server}`).join(", "));
    }
  });

  reg("mcpUnison.showInCopilotSessions", async () => {
    // No undocumented internal command is called: the documented workaround is a manual step.
    void vscode.window.showInformationMessage(msg("ext.listServersHint"));
  });

  reg("mcpUnison.chooseLanguage", async () => {
    const items = [
      { label: "English", value: "en" },
      { label: "한국어", value: "ko" },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: msg("ext.chooseLanguage.placeholder") });
    if (!pick) return;
    await cfg().update("language", pick.value, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(t(pick.value as Lang, "ext.language.saved", { name: pick.label }));
  });
}

export function deactivate(): void {
  // Everything is released through context.subscriptions.
}
