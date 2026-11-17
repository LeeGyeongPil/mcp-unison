import * as path from "node:path";
import { dedupeWarnings, type ServerSpec, type Warning } from "./model";
import { resolvePaths, type Paths } from "./paths";
import { readClaudeJson, readProjectMcp } from "./readers/claude";
import { readCodexConfig } from "./readers/codex";
import { readCopilot, type CopilotFile } from "./readers/copilot";
import { readVscodeMcp, type VscodeMcpFile } from "./readers/vscode";

export interface SourceSet {
  paths: Paths;
  projectDir?: string;
  claudeUser: ServerSpec[];
  claudeLocal: ServerSpec[];
  claudeProject: ServerSpec[];
  codex: ServerSpec[];
  vscode?: VscodeMcpFile;
  copilot?: CopilotFile;
  diagnostics: Warning[];
}

export interface LoadOptions {
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
  projectDir?: string;
  platform?: NodeJS.Platform;
  /** Re-read attempts after a parse error (the extension uses 3). */
  retries?: number;
  useClaude?: boolean;
  useCodex?: boolean;
}

export async function loadSources(opts: LoadOptions = {}): Promise<SourceSet> {
  const paths = resolvePaths({ home: opts.home, env: opts.env });
  const retries = opts.retries ?? 0;
  const platform = opts.platform ?? process.platform;
  const projectDir = opts.projectDir ? path.resolve(opts.projectDir) : undefined;

  const set: SourceSet = {
    paths,
    projectDir,
    claudeUser: [],
    claudeLocal: [],
    claudeProject: [],
    codex: [],
    diagnostics: [],
  };
  if (opts.useClaude !== false) {
    const c = await readClaudeJson(paths.claudeJson, projectDir, platform, retries);
    set.claudeUser = c.user;
    set.claudeLocal = c.local;
    set.diagnostics.push(...c.diagnostics);
    if (projectDir) set.claudeProject = await readProjectMcp(projectDir, retries);
  }
  if (opts.useCodex !== false) set.codex = await readCodexConfig(paths.codexConfig, retries);
  if (projectDir) set.vscode = readVscodeMcp(projectDir);
  set.copilot = await readCopilot(paths.copilotConfig, retries);
  return set;
}

export interface MergeResult {
  servers: ServerSpec[];
  warnings: Warning[];
}

/**
 * Claude Code precedence: local > project > user. The winning entry replaces
 * the others as a whole (fields are never merged). Codex entries only fill
 * names Claude does not define.
 */
export function mergeServers(set: SourceSet): MergeResult {
  const byName = new Map<string, ServerSpec>();
  for (const layer of [set.claudeUser, set.claudeProject, set.claudeLocal]) {
    for (const spec of layer) byName.set(spec.name, spec);
  }
  const warnings: Warning[] = [...set.diagnostics];
  for (const spec of set.codex) {
    const existing = byName.get(spec.name);
    if (existing) {
      warnings.push({
        code: "W_NAME_CONFLICT",
        server: spec.name,
        detail: existing.origin,
      });
      continue;
    }
    byName.set(spec.name, spec);
  }
  // A fixed collation locale keeps the order the same on every machine (LANG=C, ko_KR, ...).
  const servers = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const s of servers) warnings.push(...s.warnings);
  return { servers, warnings: dedupeWarnings(warnings) };
}
