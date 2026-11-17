import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseTree, type Node } from "jsonc-parser";
import {
  isClaudeOrigin,
  isRecord,
  SourceError,
  type ServerSpec,
  type Warning,
  type WarningCode,
} from "../model";
import type { Paths } from "../paths";
import type { CopilotEntry, CopilotFile } from "../readers/copilot";
import { parseJsonText, readTextIfExists } from "../readers/util";
import { blankBlocked, hasVars } from "../vars";

export interface Desired {
  /** Entries this tool would manage in the Copilot file. */
  entries: Map<string, CopilotEntry>;
  /** Servers that cannot be written, with the reason. */
  skipped: Map<string, WarningCode>;
  /** Names Copilot already reads itself (workspace `.mcp.json`). */
  native: Set<string>;
  warnings: Warning[];
}

/**
 * Mode B translation. Variables stay as `${NAME}` text so no secret value is
 * ever written to disk; only the Claude "blocked remote variable" rule is applied.
 */
export function toCopilotEntries(servers: readonly ServerSpec[], blocked: ReadonlySet<string>): Desired {
  const d: Desired = { entries: new Map(), skipped: new Map(), native: new Set(), warnings: [] };
  for (const s of servers) {
    if (s.origin === "claude-project") {
      d.native.add(s.name);
      continue;
    }
    if (s.origin === "claude-local") {
      // Local scope belongs to one project, the Copilot file is global: never write it there.
      d.skipped.set(s.name, "W_LOCAL_SCOPE_NOT_SYNCED");
      d.warnings.push({ code: "W_LOCAL_SCOPE_NOT_SYNCED", server: s.name });
      continue;
    }
    if (s.skipped) {
      d.skipped.set(s.name, s.skipped);
      continue;
    }
    if (s.transport === "stdio") {
      const e: CopilotEntry = { type: "stdio", command: s.command };
      if (s.args && s.args.length > 0) e.args = s.args;
      if (s.env && Object.keys(s.env).length > 0) e.env = s.env;
      if (s.cwd) e.cwd = s.cwd;
      e.tools = ["*"];
      d.entries.set(s.name, e);
      continue;
    }
    const useBlocked = isClaudeOrigin(s.origin);
    const noBlock: ReadonlySet<string> = new Set();
    const local: Warning[] = [];
    const clean = (value: string, field: string): string => {
      const r = blankBlocked(value, useBlocked ? blocked : noBlock);
      for (const v of r.blocked) local.push({ code: "W_BLOCKED_SECRET_VAR", server: s.name, field, detail: v });
      return r.value;
    };
    const url = clean(s.url ?? "", "url");
    if (hasVars(url)) {
      d.skipped.set(s.name, "W_URL_VAR_COPILOT");
      d.warnings.push({ code: "W_URL_VAR_COPILOT", server: s.name, field: "url", detail: url });
      continue;
    }
    const e: CopilotEntry = { type: s.transport === "sse" ? "sse" : "http", url };
    if (s.transport === "sse") local.push({ code: "W_SSE_DEPRECATED", server: s.name, detail: s.url });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.headers ?? {})) headers[k] = clean(v, `headers.${k}`);
    if (Object.keys(headers).length > 0) e.headers = headers;
    if (s.oauthClientId) e.oauthClientId = s.oauthClientId;
    e.tools = ["*"];
    d.entries.set(s.name, e);
    d.warnings.push(...local);
  }
  return d;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function entryHash(entry: unknown): string {
  return createHash("sha256").update(canonical(entry)).digest("hex").slice(0, 16);
}

/** Fields that decide whether two Copilot entries mean the same thing (`tools` is ignored). */
export function semanticEntry(e: CopilotEntry): string {
  const type = e.type === "local" || e.type === undefined ? (e.command !== undefined ? "stdio" : "http") : e.type;
  return canonical({
    type,
    command: e.command ?? null,
    args: e.args ?? [],
    env: e.env ?? {},
    cwd: e.cwd ?? null,
    url: e.url ?? null,
    headers: e.headers ?? {},
    oauthClientId: e.oauthClientId ?? null,
  });
}

export interface Lock {
  version: 1;
  managed: Record<string, string>;
}

export function readLock(file: string): Lock {
  const text = readTextIfExists(file);
  if (text === undefined) return { version: 1, managed: {} };
  const root = parseJsonText(text, file);
  if (!isRecord(root) || !isRecord(root.managed)) {
    throw new SourceError(file, "err.lockShape");
  }
  const managed: Record<string, string> = {};
  for (const [k, v] of Object.entries(root.managed)) if (typeof v === "string") managed[k] = v;
  return { version: 1, managed };
}

function lockText(lock: Lock): string {
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(lock.managed).sort()) sorted[k] = lock.managed[k];
  return JSON.stringify({ version: 1, managed: sorted }, null, 2) + "\n";
}

export type SyncKind = "add" | "update" | "remove" | "adopt" | "unchanged" | "conflict" | "kept-user" | "forget";

export interface SyncAction {
  name: string;
  action: SyncKind;
}

export interface SyncPlan {
  actions: SyncAction[];
  oldText: string | null;
  newText: string;
  oldLockText: string | null;
  newLockText: string;
  configChanged: boolean;
  lockChanged: boolean;
  changed: boolean;
  conflicts: string[];
  warnings: Warning[];
  file: string;
  lockFile: string;
}

function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(start));
  return m ? m[0] : "";
}

function indentJson(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).split("\n").join(`\n${indent}`);
}

function propNode(obj: Node | undefined, key: string): Node | undefined {
  return obj?.children?.find((p) => p.type === "property" && p.children?.[0]?.value === key);
}

function addProp(text: string, obj: Node, objIndent: string, key: string, value: unknown): string {
  const children = obj.children ?? [];
  if (children.length > 0) {
    const last = children[children.length - 1];
    const indent = lineIndent(text, last.offset);
    const pos = last.offset + last.length;
    return `${text.slice(0, pos)},\n${indent}${JSON.stringify(key)}: ${indentJson(value, indent)}${text.slice(pos)}`;
  }
  const indent = `${objIndent}  `;
  const body = `{\n${indent}${JSON.stringify(key)}: ${indentJson(value, indent)}\n${objIndent}}`;
  return text.slice(0, obj.offset) + body + text.slice(obj.offset + obj.length);
}

/**
 * Edit one `mcpServers` entry with minimal text splices, so comments, spacing and
 * every other entry or top-level key stay byte for byte as the user wrote them.
 * `value === undefined` removes the entry.
 */
export function editEntry(text: string, name: string, value: unknown, file = "mcp-config.json"): string {
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (!root || root.type !== "object") {
    throw new SourceError(file, "err.notObject");
  }
  const mcpProp = propNode(root, "mcpServers");
  const servers = mcpProp?.children?.[1];
  if (!servers || servers.type !== "object") {
    if (value === undefined) return text;
    if (mcpProp) throw new SourceError(file, "err.mcpServersNotObject");
    return addProp(text, root, "", "mcpServers", { [name]: value });
  }
  const existing = propNode(servers, name);
  if (value === undefined) {
    if (!existing) return text;
    const kids = servers.children ?? [];
    const i = kids.indexOf(existing);
    if (kids.length === 1) return text.slice(0, servers.offset) + "{}" + text.slice(servers.offset + servers.length);
    const end = existing.offset + existing.length;
    if (i < kids.length - 1) {
      // Drop the entry and its comma; comments between it and the next entry stay.
      const gap = text.slice(end, kids[i + 1].offset).replace(/^[ \t]*,[ \t]*/, "");
      const lineStart = text.lastIndexOf("\n", existing.offset - 1) + 1;
      if (/^[ \t]*$/.test(text.slice(lineStart, existing.offset)) && /^\r?\n/.test(gap)) {
        return text.slice(0, lineStart) + gap.replace(/^\r?\n/, "") + text.slice(kids[i + 1].offset);
      }
      return text.slice(0, existing.offset) + gap + text.slice(kids[i + 1].offset);
    }
    // Last entry: the comma after the previous entry goes, comments in the gap stay.
    const prev = kids[i - 1];
    const prevEnd = prev.offset + prev.length;
    const gap = text.slice(prevEnd, existing.offset).replace(",", "").replace(/\s+$/, "");
    const tail = text.slice(end).replace(/^[ \t]*,/, "");
    return text.slice(0, prevEnd) + gap + tail;
  }
  if (existing) {
    const valueNode = existing.children?.[1];
    if (!valueNode) return text;
    const indent = lineIndent(text, existing.offset);
    return text.slice(0, valueNode.offset) + indentJson(value, indent) + text.slice(valueNode.offset + valueNode.length);
  }
  return addProp(text, servers, lineIndent(text, mcpProp ? mcpProp.offset : 0), name, value);
}

export function planCopilotSync(
  desired: Desired,
  current: CopilotFile | undefined,
  lock: Lock,
  paths: Pick<Paths, "copilotConfig" | "lockFile">,
): SyncPlan {
  const entriesNow = current?.entries ?? {};
  const oldText = current ? current.text : null;
  let text = current && current.text.trim() !== "" ? current.text : "{}\n";
  const actions: SyncAction[] = [];
  const warnings: Warning[] = [];
  const conflicts: string[] = [];
  const managed: Record<string, string> = {};

  const setEntry = (name: string, value: unknown): void => {
    text = editEntry(text, name, value, paths.copilotConfig);
  };

  for (const [name, want] of desired.entries) {
    const have = entriesNow[name];
    const wantHash = entryHash(want);
    if (have === undefined) {
      setEntry(name, want);
      managed[name] = wantHash;
      actions.push({ name, action: "add" });
    } else if (lock.managed[name] !== undefined) {
      if (entryHash(have) !== lock.managed[name]) {
        conflicts.push(name);
        managed[name] = lock.managed[name];
        actions.push({ name, action: "conflict" });
      } else if (entryHash(have) === wantHash) {
        managed[name] = wantHash;
        actions.push({ name, action: "unchanged" });
      } else {
        setEntry(name, want);
        managed[name] = wantHash;
        actions.push({ name, action: "update" });
      }
    } else if (semanticEntry(have) === semanticEntry(want)) {
      // Already identical: start managing it without touching the file.
      managed[name] = entryHash(have);
      actions.push({ name, action: "adopt" });
    } else {
      warnings.push({ code: "W_COPILOT_ENTRY_EXISTS", server: name });
      actions.push({ name, action: "kept-user" });
    }
  }

  for (const [name, hash] of Object.entries(lock.managed)) {
    if (desired.entries.has(name)) continue;
    const have = entriesNow[name];
    if (have === undefined) {
      actions.push({ name, action: "forget" });
    } else if (entryHash(have) !== hash) {
      conflicts.push(name);
      managed[name] = hash;
      actions.push({ name, action: "conflict" });
    } else {
      setEntry(name, undefined);
      actions.push({ name, action: "remove" });
    }
  }

  const oldLockText = readTextIfExists(paths.lockFile) ?? null;
  const newLockText = lockText({ version: 1, managed });
  const lockChanged = oldLockText === null ? Object.keys(managed).length > 0 : oldLockText !== newLockText;
  const configTouched = actions.some((a) => a.action === "add" || a.action === "update" || a.action === "remove");
  const newText = configTouched ? text : (oldText ?? "");
  const configChanged = configTouched && newText !== oldText;

  return {
    actions,
    oldText,
    newText,
    oldLockText,
    newLockText,
    configChanged,
    lockChanged,
    changed: configChanged || lockChanged,
    conflicts,
    warnings,
    file: paths.copilotConfig,
    lockFile: paths.lockFile,
  };
}

/** Write via a temp file, keeping the existing mode (0600 for new files) and following symlinks. */
function writeAtomic(file: string, content: string): void {
  let target = file;
  let mode = 0o600;
  try {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    /* the file does not exist yet */
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode });
    fs.chmodSync(tmp, mode); // beats the umask
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Write the planned change. Returns the files that were written. */
export function applyCopilotSync(plan: SyncPlan): string[] {
  const written: string[] = [];
  if (plan.configChanged) {
    if (plan.oldText !== null) {
      fs.copyFileSync(plan.file, `${plan.file}.bak`);
      fs.chmodSync(`${plan.file}.bak`, fs.statSync(plan.file).mode & 0o777);
    }
    writeAtomic(plan.file, plan.newText);
    written.push(plan.file);
  }
  if (plan.lockChanged) {
    writeAtomic(plan.lockFile, plan.newLockText);
    written.push(plan.lockFile);
  }
  return written;
}
