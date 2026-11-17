import * as path from "node:path";
import {
  isRecord,
  SourceError,
  stringRecord,
  type Origin,
  type ServerSpec,
  type Warning,
  type WarningCode,
} from "../model";
import { findLocalKey } from "../paths";
import { parseJsonText, readParsed } from "./util";

/** Convert one Claude Code `mcpServers` entry. The whole entry comes from one scope. */
export function claudeEntryToSpec(name: string, raw: unknown, origin: Origin): ServerSpec {
  const spec: ServerSpec = { name, origin, transport: "stdio", warnings: [] };
  const warn = (code: WarningCode, field?: string, detail?: string): void => {
    spec.warnings.push({ code, server: name, field, detail });
  };
  const skip = (code: WarningCode, field?: string, detail?: string): ServerSpec => {
    spec.skipped = code;
    warn(code, field, detail);
    return spec;
  };

  if (!isRecord(raw)) return skip("W_INVALID_ENTRY", undefined, "object");
  const type = typeof raw.type === "string" ? raw.type : undefined;
  const command = typeof raw.command === "string" ? raw.command : undefined;
  const url = typeof raw.url === "string" ? raw.url : undefined;

  if (type === undefined || type === "stdio") {
    if (command === undefined) {
      if (type === undefined && url !== undefined) {
        // Claude Code reads an entry without "type" as stdio, so a bare url is a config error there too.
        return skip("W_URL_WITHOUT_TYPE", "type");
      }
      return skip("W_INVALID_ENTRY", "command", "command");
    }
    spec.transport = "stdio";
    spec.command = command;
    spec.args = Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : [];
    spec.env = stringRecord(raw.env) ?? {};
    return spec;
  }

  if (type === "http" || type === "streamable-http" || type === "sse") {
    if (url === undefined) return skip("W_INVALID_ENTRY", "url", "url");
    spec.transport = type === "sse" ? "sse" : "http";
    spec.url = url;
    spec.headers = stringRecord(raw.headers) ?? {};
    if (raw.headersHelper !== undefined) {
      return skip("W_HEADERS_HELPER", "headersHelper");
    }
    if (isRecord(raw.oauth)) {
      if (typeof raw.oauth.clientId === "string") spec.oauthClientId = raw.oauth.clientId;
      const others = Object.keys(raw.oauth).filter((k) => k !== "clientId");
      if (others.length > 0) warn("W_OAUTH_PARTIAL", "oauth", others.join(", "));
    }
    return spec;
  }

  return skip("W_TRANSPORT_UNSUPPORTED", "type", String(type));
}

export function entriesToSpecs(entries: unknown, origin: Origin): ServerSpec[] {
  if (!isRecord(entries)) return [];
  return Object.entries(entries).map(([name, raw]) => claudeEntryToSpec(name, raw, origin));
}

export interface ClaudeJson {
  user: ServerSpec[];
  local: ServerSpec[];
  diagnostics: Warning[];
}

/** Parse `~/.claude.json` text. Only the keys we need are kept. */
export function parseClaudeJson(
  text: string,
  file: string,
  projectDir: string | undefined,
  platform: NodeJS.Platform = process.platform,
): ClaudeJson {
  const root = parseJsonText(text, file);
  if (!isRecord(root)) {
    return parseFail(file);
  }
  const user = entriesToSpecs(root.mcpServers, "claude-user");
  let local: ServerSpec[] = [];
  const diagnostics: Warning[] = [];
  if (projectDir && isRecord(root.projects)) {
    const keys = Object.keys(root.projects);
    const hit = findLocalKey(keys, projectDir, platform);
    if (hit.key !== undefined) {
      const proj = root.projects[hit.key];
      if (isRecord(proj)) local = entriesToSpecs(proj.mcpServers, "claude-local");
    } else if (hit.nearest !== undefined) {
      diagnostics.push({
        code: "W_LOCAL_SCOPE_NOT_FOUND",
        server: "*",
        detail: hit.nearest,
      });
    }
  }
  return { user, local, diagnostics };
}

function parseFail(file: string): never {
  throw new SourceError(file, "err.notObject");
}

export async function readClaudeJson(
  file: string,
  projectDir: string | undefined,
  platform: NodeJS.Platform,
  retries: number,
): Promise<ClaudeJson> {
  const r = await readParsed(file, (t) => parseClaudeJson(t, file, projectDir, platform), retries);
  return r ?? { user: [], local: [], diagnostics: [] };
}

/** Workspace `.mcp.json` (Claude Code project scope, also read by Copilot). */
export async function readProjectMcp(projectDir: string, retries: number): Promise<ServerSpec[]> {
  const file = path.join(projectDir, ".mcp.json");
  const r = await readParsed(
    file,
    (t) => {
      const root = parseJsonText(t, file);
      return isRecord(root) ? entriesToSpecs(root.mcpServers, "claude-project") : [];
    },
    retries,
  );
  return r ?? [];
}
