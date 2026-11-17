import * as fs from "node:fs";
import * as path from "node:path";
import type { DriftReport } from "../core/drift";
import { hasVars } from "../core/vars";
import type { ServerSpec, Warning } from "../core/model";
import { t, warningMessage, type Lang } from "../i18n";

/** True when `command` can be found (existence check only, nothing is executed). */
export function commandOnPath(
  command: string,
  pathVar: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const exts = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  const isFile = (p: string): boolean => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes("/") || command.includes("\\")) return exts.some((e) => isFile(command + e));
  const sep = platform === "win32" ? ";" : ":";
  for (const dir of (pathVar ?? "").split(sep)) {
    if (dir && exts.some((e) => isFile(path.join(dir, command + e)))) return true;
  }
  return false;
}

/** GUI-launched editors often miss the shell PATH, so say so when a command cannot be found. */
export function pathWarnings(
  servers: readonly ServerSpec[],
  pathVar: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Warning[] {
  const out: Warning[] = [];
  for (const s of servers) {
    if (s.skipped || s.transport !== "stdio" || !s.command || hasVars(s.command)) continue;
    if (!commandOnPath(s.command, pathVar, platform)) {
      out.push({ code: "W_COMMAND_NOT_ON_PATH", server: s.name, field: "command", detail: s.command });
    }
  }
  return out;
}

/** Markdown drift report opened as an untitled document. */
export function buildReport(lang: Lang, report: DriftReport, extra: readonly Warning[] = []): string {
  const lines: string[] = [];
  lines.push(`# ${t(lang, "ext.report.title")}`, "");
  lines.push(t(lang, "ext.report.summary", { count: report.rows.length }), "");
  lines.push(`| ${t(lang, "col.name")} | ${t(lang, "col.sources")} | ${t(lang, "col.status")} | ${t(lang, "col.notes")} |`);
  lines.push("|---|---|---|---|");
  for (const r of report.rows) {
    const src = [
      r.sources.claude ? `claude:${r.sources.claude}` : "",
      r.sources.codex ? "codex" : "",
      r.sources.vscode ? "vscode" : "",
      r.sources.copilot ? "copilot" : "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`| ${r.name} | ${src} | ${r.status} | ${r.warnings.join(", ")} |`);
  }
  lines.push("", t(lang, "ext.report.legend"), "", `## ${t(lang, "ext.report.warnings")}`, "");
  const all = [...report.warnings, ...extra];
  if (all.length === 0) lines.push(t(lang, "ext.report.none"));
  for (const w of all) lines.push(`- \`${w.code}\` ${w.server === "*" ? "" : `**${w.server}**: `}${warningMessage(lang, w)}`);
  return lines.join("\n") + "\n";
}
