#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeDrift, hasDrift, isDriftRow, type DriftRow } from "./core/drift";
import { loadSources } from "./core/merge";
import { SourceError, type ServerSpec, type Warning } from "./core/model";
import { applyCopilotSync, planCopilotSync, readLock } from "./core/targets/copilot";
import { exportToClaude, type ExportFormat } from "./core/targets/claude";
import { unifiedDiff } from "./core/textdiff";
import { blockedSet } from "./core/vars";
import { isLang, resolveLang, sourceErrorMessage, t, warningMessage, type Lang } from "./i18n";
import type { MessageKey } from "./i18n/en";

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
}

interface Args {
  command?: string;
  home?: string;
  project?: string;
  json: boolean;
  demo: boolean;
  check: boolean;
  write: boolean;
  format?: string;
  lang?: string;
  blockedVars: string[];
  help: boolean;
  version: boolean;
}

class UsageError extends Error {
  constructor(readonly key: MessageKey, readonly params: Record<string, string> = {}) {
    super(key);
  }
}

const VALUE_FLAGS = new Set(["--home", "--project", "--format", "--lang", "--blocked-var"]);
const BOOL_FLAGS = new Set(["--json", "--demo", "--check", "--write", "--help", "-h", "--version", "-v"]);

function parseArgs(argv: readonly string[]): Args {
  const a: Args = {
    json: false,
    demo: false,
    check: false,
    write: false,
    blockedVars: [],
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = inline ?? argv[++i];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) {
        throw new UsageError("cli.err.needValue", { name: arg });
      }
      if (arg === "--home") a.home = value;
      else if (arg === "--project") a.project = value;
      else if (arg === "--format") a.format = value;
      else if (arg === "--lang") a.lang = value;
      else a.blockedVars.push(value);
    } else if (BOOL_FLAGS.has(arg)) {
      if (arg === "--json") a.json = true;
      else if (arg === "--demo") a.demo = true;
      else if (arg === "--check") a.check = true;
      else if (arg === "--write") a.write = true;
      else if (arg === "--help" || arg === "-h") a.help = true;
      else a.version = true;
    } else if (arg.startsWith("-")) {
      throw new UsageError("cli.err.unknownFlag", { name: arg });
    } else if (a.command === undefined) {
      a.command = arg;
    } else {
      throw new UsageError("cli.err.unknownCommand", { name: arg });
    }
  }
  return a;
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i])))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

function sourcesText(row: DriftRow): string {
  const parts: string[] = [];
  if (row.sources.claude) parts.push(`claude:${row.sources.claude}`);
  if (row.sources.codex) parts.push("codex");
  if (row.sources.vscode) parts.push("vscode");
  if (row.sources.copilot) parts.push("copilot");
  return parts.join(",");
}

function warningJson(lang: Lang, w: Warning): Record<string, unknown> {
  return { code: w.code, server: w.server, field: w.field, detail: w.detail, message: warningMessage(lang, w) };
}

function warningLines(lang: Lang, warnings: readonly Warning[]): string {
  if (warnings.length === 0) return "";
  const lines = warnings.map((w) => `  ${w.code}  ${w.server === "*" ? "" : w.server + ": "}${warningMessage(lang, w)}`);
  return `\n${t(lang, "cli.warningsTitle")}:\n${lines.join("\n")}\n`;
}

function targetText(s: ServerSpec): string {
  if (s.transport === "stdio") return [s.command ?? "", ...(s.args ?? [])].join(" ").trim();
  return s.url ?? "";
}

/** Copy the practice mock home into a temp folder and point its local scope at the copy. */
function prepareDemo(lang: Lang): { home: string; project: string; cleanup: () => void } {
  const src = path.resolve(__dirname, "..", "..", "examples", "demo-home");
  if (!fs.existsSync(src)) throw new UsageError("cli.err.demoMissing", { path: src });
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-unison-demo-")));
  fs.cpSync(src, tmp, { recursive: true });
  const project = path.join(tmp, "project");
  const claudeJson = path.join(tmp, ".claude.json");
  const text = fs.readFileSync(claudeJson, "utf8").split("__DEMO_PROJECT__").join(JSON.stringify(project).slice(1, -1));
  fs.writeFileSync(claudeJson, text);
  void lang;
  return { home: tmp, project, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let lang: Lang = resolveLang({ env: io.env });
  try {
    // Pick the language first so even usage errors are localised.
    const pre = argv.findIndex((x) => x === "--lang" || x.startsWith("--lang="));
    if (pre >= 0) {
      const raw = argv[pre].includes("=") ? argv[pre].split("=")[1] : argv[pre + 1];
      if (isLang(raw)) lang = raw;
    }
    const args = parseArgs(argv);
    if (args.lang !== undefined && !isLang(args.lang)) throw new UsageError("cli.err.badLang", { value: args.lang });
    lang = resolveLang({ flag: args.lang, env: io.env });

    if (args.help || (argv.length === 0 && !args.command)) {
      io.out(t(lang, "cli.help") + "\n");
      return 0;
    }
    if (args.version) {
      io.out(`${(require("../../package.json") as { version: string }).version}\n`);
      return 0;
    }
    if (!args.command) throw new UsageError("cli.err.noCommand");
    if (!["list", "diff", "sync-copilot", "export-claude"].includes(args.command)) {
      throw new UsageError("cli.err.unknownCommand", { name: args.command });
    }
    if (args.format !== undefined && args.format !== "mcp-json" && args.format !== "add-json") {
      throw new UsageError("cli.err.badFormat", { value: args.format });
    }

    let demo: ReturnType<typeof prepareDemo> | undefined;
    try {
      let home = args.home;
      let project = path.resolve(io.cwd, args.project ?? ".");
      if (args.demo) {
        demo = prepareDemo(lang);
        home = demo.home;
        project = demo.project;
        io.err(t(lang, "cli.demoNotice") + "\n");
      }
      if (!args.demo) {
        // Only explicitly given paths are validated; defaults keep today's behaviour.
        const checks: Array<[string, string | undefined]> = [
          ["--home", args.home === undefined ? undefined : path.resolve(io.cwd, args.home)],
          ["--project", args.project === undefined ? undefined : project],
        ];
        for (const [flag, p] of checks) {
          if (p !== undefined && !(fs.existsSync(p) && fs.statSync(p).isDirectory())) {
            throw new UsageError("cli.err.badDir", { flag, path: p });
          }
        }
      }
      const blocked = blockedSet(args.blockedVars);
      const set = await loadSources({ home, env: io.env, projectDir: project });
      const lock = readLock(set.paths.lockFile);
      const report = () => computeDrift(set, { env: io.env, blocked, lock });

      if (args.command === "list") return runList(args, lang, io, report());
      if (args.command === "diff") return runDiff(args, lang, io, report());
      if (args.command === "sync-copilot") return runSync(args, lang, io, set, report(), Boolean(demo));
      return runExport(args, lang, io, set.paths.home, project);
    } finally {
      demo?.cleanup();
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`${t(lang, "cli.err.prefix")}: ${t(lang, err.key, err.params)}\n`);
      return 2;
    }
    if (err instanceof SourceError) {
      io.err(`${t(lang, "cli.err.prefix")}: ${sourceErrorMessage(lang, err)}\n`);
      return 2;
    }
    throw err;
  }
}

function runList(args: Args, lang: Lang, io: CliIo, r: ReturnType<typeof computeDrift>): number {
  const servers = r.merged.servers;
  if (args.json) {
    io.out(
      JSON.stringify(
        {
          servers: servers.map((s) => ({
            name: s.name,
            origin: s.origin,
            transport: s.transport,
            target: targetText(s),
            skipped: s.skipped,
            warnings: [...new Set(r.warnings.filter((w) => w.server === s.name).map((w) => w.code))],
          })),
          warnings: r.warnings.map((w) => warningJson(lang, w)),
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  if (servers.length === 0) {
    io.out(t(lang, "cli.noServers") + "\n");
    return 0;
  }
  const rows = servers.map((s) => [
    s.name,
    s.origin,
    s.transport,
    targetText(s),
    [...new Set(r.warnings.filter((w) => w.server === s.name).map((w) => w.code))].join(","),
  ]);
  io.out(
    renderTable(
      [t(lang, "col.name"), t(lang, "col.origin"), t(lang, "col.transport"), t(lang, "col.target"), t(lang, "col.notes")],
      rows,
    ) + "\n",
  );
  io.out(warningLines(lang, r.warnings));
  return 0;
}

function runDiff(args: Args, lang: Lang, io: CliIo, r: ReturnType<typeof computeDrift>): number {
  const drift = hasDrift(r.rows);
  if (args.json) {
    io.out(
      JSON.stringify(
        {
          servers: r.rows.map((row) => ({
            name: row.name,
            sources: row.sources,
            status: row.status,
            warnings: row.warnings,
          })),
          warnings: r.warnings.map((w) => warningJson(lang, w)),
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    const rows = r.rows.map((row) => [row.name, sourcesText(row), row.status, row.warnings.join(",")]);
    io.out(
      renderTable([t(lang, "col.name"), t(lang, "col.sources"), t(lang, "col.status"), t(lang, "col.notes")], rows) + "\n",
    );
    io.out(warningLines(lang, r.warnings));
    const count = r.rows.filter(isDriftRow).length;
    const kept = r.rows.filter((x) => x.status === "kept-user").length;
    io.out("\n" + (drift ? t(lang, "cli.drift.found", { count }) : t(lang, "cli.drift.none")) + "\n");
    if (kept > 0) io.out(t(lang, "cli.drift.keptUser", { count: kept }) + "\n");
  }
  return args.check && drift ? 1 : 0;
}

function runSync(
  args: Args,
  lang: Lang,
  io: CliIo,
  set: Awaited<ReturnType<typeof loadSources>>,
  r: ReturnType<typeof computeDrift>,
  isDemo: boolean,
): number {
  const lock = readLock(set.paths.lockFile);
  const plan = planCopilotSync(r.desired, set.copilot, lock, set.paths);
  const written = args.write ? applyCopilotSync(plan) : [];
  const diff = plan.configChanged
    ? unifiedDiff(plan.oldText ?? "", plan.newText, plan.oldText === null ? "/dev/null" : plan.file, plan.file)
    : "";
  const exit = args.write && plan.conflicts.length > 0 ? 1 : 0;

  if (args.json) {
    io.out(
      JSON.stringify(
        {
          changed: plan.changed,
          written,
          actions: plan.actions,
          conflicts: plan.conflicts,
          diff,
          warnings: [...r.warnings, ...plan.warnings].map((w) => warningJson(lang, w)),
        },
        null,
        2,
      ) + "\n",
    );
    return exit;
  }

  const shown = plan.actions.filter((a) => a.action !== "unchanged");
  if (!plan.changed && plan.conflicts.length === 0) {
    io.out(t(lang, "cli.sync.noChanges") + "\n");
  } else {
    for (const a of shown) io.out(`  ${a.name}: ${t(lang, `cli.action.${a.action}` as MessageKey)}\n`);
    if (diff) io.out("\n" + diff);
    if (args.write && written.length > 0) {
      io.out("\n" + t(lang, "cli.sync.written", { files: written.join(", ") }) + "\n");
      if (plan.oldText !== null && plan.configChanged) {
        io.out(t(lang, "cli.sync.backup", { path: `${plan.file}.bak` }) + "\n");
      }
      if (isDemo) io.out(t(lang, "cli.sync.demoWrite") + "\n");
    } else if (!args.write && plan.changed) {
      io.out("\n" + t(lang, "cli.sync.previewTitle") + "\n  mcp-unison sync-copilot --write\n");
    }
  }
  if (plan.conflicts.length > 0) {
    io.out(
      `\n${t(lang, "cli.sync.conflictTitle")}\n  ${plan.conflicts.join(", ")}\n${t(lang, "cli.sync.conflictHint", { lock: plan.lockFile })}\n`,
    );
  }
  io.out(warningLines(lang, plan.warnings));
  return exit;
}

function runExport(args: Args, lang: Lang, io: CliIo, home: string, project: string): number {
  const file = path.join(project, ".vscode", "mcp.json");
  if (!fs.existsSync(file)) throw new UsageError("cli.err.noVscodeFile", { path: file });
  const result = exportToClaude(fs.readFileSync(file, "utf8"), file, {
    format: (args.format ?? "mcp-json") as ExportFormat,
    workspaceFolder: project,
    userHome: home,
  });
  if (args.json) {
    io.out(
      JSON.stringify(
        {
          format: args.format ?? "mcp-json",
          text: result.text,
          exported: result.exported,
          excluded: result.excluded,
          warnings: result.warnings.map((w) => warningJson(lang, w)),
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  io.out(result.text);
  if (result.excluded.length > 0) io.err(t(lang, "cli.export.excluded", { names: result.excluded.join(", ") }) + "\n");
  io.err(warningLines(lang, result.warnings));
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2), {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    env: process.env,
    cwd: process.cwd(),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
      process.exitCode = 2;
    },
  );
}
