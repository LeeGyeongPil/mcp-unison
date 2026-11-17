import * as path from "node:path";
import { stringRecord, type Warning } from "../model";
import { parseVscodeMcp } from "../readers/vscode";

export type ExportFormat = "mcp-json" | "add-json";

export interface ExportOptions {
  format: ExportFormat;
  /** Absolute workspace folder used to resolve `${workspaceFolder}`. */
  workspaceFolder: string;
  userHome: string;
}

export interface ExportResult {
  text: string;
  warnings: Warning[];
  exported: string[];
  excluded: string[];
}

const ENV_RE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
const INPUT_RE = /\$\{(input|command):[^}]*\}/;

function convertString(
  value: string,
  server: string,
  field: string,
  opts: ExportOptions,
  warnings: Warning[],
): string {
  let out = value.replace(ENV_RE, (_m, name: string) => `\${${name}}`);
  const replacePath = (token: string, abs: string): void => {
    if (out.includes(token)) {
      out = out.split(token).join(abs);
      warnings.push({ code: "W_RESOLVED_PATH", server, field, detail: `${token} -> ${abs}` });
    }
  };
  replacePath("${workspaceFolder}", opts.workspaceFolder);
  replacePath("${userHome}", opts.userHome);
  return out;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function shellName(name: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(name) ? name : shellQuote(name);
}

/** VS Code `.vscode/mcp.json` text (JSONC) to Claude Code format. */
export function exportToClaude(vscodeText: string, file: string, opts: ExportOptions): ExportResult {
  const parsed = parseVscodeMcp(vscodeText, file);
  const warnings: Warning[] = [];
  const result: Record<string, Record<string, unknown>> = {};
  const excluded: string[] = [];

  for (const [name, raw] of Object.entries(parsed.servers)) {
    const strings = JSON.stringify(raw);
    if (INPUT_RE.test(strings)) {
      excluded.push(name);
      const hit = /\$\{(?:input|command):[^}]*\}/.exec(strings);
      warnings.push({ code: "W_INPUT_VAR", server: name, detail: hit ? hit[0] : undefined });
      continue;
    }
    for (const field of ["envFile", "dev", "sandbox", "cwd"]) {
      if (raw[field] !== undefined) warnings.push({ code: "W_DROPPED_FIELD", server: name, field });
    }
    const conv = (v: string, f: string): string => convertString(v, name, f, opts, warnings);
    const type = typeof raw.type === "string" ? raw.type : typeof raw.url === "string" ? "http" : "stdio";
    const out: Record<string, unknown> = {};
    if (type === "stdio") {
      out.type = "stdio";
      out.command = conv(String(raw.command ?? ""), "command");
      if (Array.isArray(raw.args) && raw.args.length > 0) {
        out.args = raw.args.map((a, i) => conv(String(a), `args[${i}]`));
      }
      const env = stringRecord(raw.env);
      if (env && Object.keys(env).length > 0) {
        out.env = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, conv(v, `env.${k}`)]));
      }
    } else {
      out.type = type === "sse" ? "sse" : "http";
      out.url = conv(String(raw.url ?? ""), "url");
      const headers = stringRecord(raw.headers);
      if (headers && Object.keys(headers).length > 0) {
        out.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, conv(v, `headers.${k}`)]));
      }
    }
    result[name] = out;
  }

  const exported = Object.keys(result);
  let text: string;
  if (opts.format === "mcp-json") {
    text = JSON.stringify({ mcpServers: result }, null, 2) + "\n";
  } else {
    text = exported
      .map((n) => `claude mcp add-json ${shellName(n)} ${shellQuote(JSON.stringify(result[n]))}`)
      .join("\n");
    if (text) text += "\n";
  }
  return { text, warnings, exported, excluded };
}

export function defaultWorkspaceFolder(project: string | undefined): string {
  return path.resolve(project ?? process.cwd());
}
