import { mergeServers, type MergeResult, type SourceSet } from "./merge";
import { dedupeWarnings, type Warning } from "./model";
import { semanticEntry, toCopilotEntries, type Desired, type Lock } from "./targets/copilot";
import { toProviderDefs } from "./targets/provider";

export type DriftStatus =
  | "same"
  | "different"
  | "only-source"
  | "only-copilot"
  | "stale-managed"
  | "kept-user"
  | "only-vscode"
  | "native"
  | "skipped";

export interface DriftRow {
  name: string;
  sources: {
    claude?: "user" | "local" | "project";
    codex?: true;
    vscode?: true;
    copilot?: true;
  };
  status: DriftStatus;
  warnings: string[];
}

export interface DriftReport {
  merged: MergeResult;
  desired: Desired;
  rows: DriftRow[];
  /** Every warning from reading, translating (mode B) and resolving variables (mode A). */
  warnings: Warning[];
}

export interface DriftOptions {
  env: Readonly<Record<string, string | undefined>>;
  blocked: ReadonlySet<string>;
  /** Entries a previous sync wrote. Without it every Copilot entry counts as yours. */
  lock?: Lock;
}

export function computeDrift(set: SourceSet, opts: DriftOptions): DriftReport {
  const merged = mergeServers(set);
  // Local scope is private to one project, so the global Copilot file only ever gets the
  // servers that are visible without it (a local server may shadow a global one).
  const global = mergeServers({ ...set, claudeLocal: [] }).servers;
  const desired = toCopilotEntries([...global, ...merged.servers.filter((s) => s.origin === "claude-local")], opts.blocked);
  const provider = toProviderDefs(merged.servers, opts.env, { blocked: opts.blocked });
  const warnings = dedupeWarnings([...merged.warnings, ...desired.warnings, ...provider.warnings]);

  const managed = opts.lock?.managed ?? {};
  const copilotEntries = set.copilot?.entries ?? {};
  const vscodeServers = set.vscode?.servers ?? {};
  const rows: DriftRow[] = [];
  const seen = new Set<string>();

  for (const s of merged.servers) {
    seen.add(s.name);
    const row: DriftRow = {
      name: s.name,
      sources: {},
      status: "same",
      warnings: [...new Set(warnings.filter((w) => w.server === s.name).map((w) => w.code))],
    };
    if (s.origin === "codex") row.sources.codex = true;
    else row.sources.claude = s.origin === "claude-user" ? "user" : s.origin === "claude-local" ? "local" : "project";
    if (vscodeServers[s.name]) row.sources.vscode = true;
    const have = copilotEntries[s.name];
    if (have) row.sources.copilot = true;

    const want = desired.entries.get(s.name);
    if (s.origin === "claude-project") row.status = "native";
    else if (!want) row.status = "skipped";
    else if (!have) row.status = "only-source";
    else if (semanticEntry(have) === semanticEntry(want)) row.status = "same";
    else if (managed[s.name] === undefined) {
      // An entry you wrote yourself: sync-copilot keeps it, so it is not drift to fix.
      row.status = "kept-user";
      if (!row.warnings.includes("W_COPILOT_ENTRY_EXISTS")) row.warnings.push("W_COPILOT_ENTRY_EXISTS");
    } else row.status = "different";
    rows.push(row);
  }

  for (const name of Object.keys(copilotEntries)) {
    if (seen.has(name)) continue;
    seen.add(name);
    // Written by an earlier sync but no longer wanted: the next sync removes it.
    const status = managed[name] !== undefined ? "stale-managed" : "only-copilot";
    const row: DriftRow = { name, sources: { copilot: true }, status, warnings: [] };
    if (vscodeServers[name]) row.sources.vscode = true;
    rows.push(row);
  }
  for (const name of Object.keys(vscodeServers)) {
    if (seen.has(name)) continue;
    rows.push({ name, sources: { vscode: true }, status: "only-vscode", warnings: [] });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, "en")); // fixed locale: same order on every machine
  return { merged, desired, rows, warnings };
}

/** Rows that `sync-copilot --write` would change. */
export function isDriftRow(r: DriftRow): boolean {
  return r.status === "different" || r.status === "only-source" || r.status === "stale-managed";
}

export function hasDrift(rows: readonly DriftRow[]): boolean {
  return rows.some(isDriftRow);
}
