import { parse as parseToml } from "smol-toml";
import { isRecord, SourceError, stringRecord, type ServerSpec, type WarningCode } from "../model";
import { readParsed } from "./util";

/** Convert the `[mcp_servers.<name>]` tables of a Codex `config.toml`. */
export function codexToSpecs(root: unknown): ServerSpec[] {
  if (!isRecord(root) || !isRecord(root.mcp_servers)) return [];
  return Object.entries(root.mcp_servers).map(([name, raw]) => codexEntryToSpec(name, raw));
}

export function codexEntryToSpec(name: string, raw: unknown): ServerSpec {
  const spec: ServerSpec = { name, origin: "codex", transport: "stdio", warnings: [] };
  const skip = (code: WarningCode, field?: string, detail?: string): ServerSpec => {
    spec.skipped = code;
    spec.warnings.push({ code, server: name, field, detail });
    return spec;
  };
  if (!isRecord(raw)) return skip("W_INVALID_ENTRY", undefined, "table");
  if (raw.enabled === false) return skip("W_DISABLED", "enabled");

  if (typeof raw.command === "string") {
    spec.transport = "stdio";
    spec.command = raw.command;
    spec.args = Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : [];
    const env = stringRecord(raw.env) ?? {};
    // Codex forwards the *names* in env_vars from its own environment; the neutral model uses ${NAME}.
    if (Array.isArray(raw.env_vars)) {
      for (const v of raw.env_vars) {
        const n = typeof v === "string" ? v : isRecord(v) && typeof v.name === "string" ? v.name : undefined;
        if (n && !(n in env)) env[n] = `\${${n}}`;
      }
    }
    spec.env = env;
    if (typeof raw.cwd === "string") spec.cwd = raw.cwd;
    return spec;
  }

  if (typeof raw.url === "string") {
    spec.transport = "http";
    spec.url = raw.url;
    const headers = stringRecord(raw.http_headers) ?? {};
    if (isRecord(raw.env_http_headers)) {
      for (const [header, v] of Object.entries(raw.env_http_headers)) {
        if (typeof v === "string") headers[header] = `\${${v}}`;
      }
    }
    if (typeof raw.bearer_token_env_var === "string") {
      headers.Authorization = `Bearer \${${raw.bearer_token_env_var}}`;
    }
    spec.headers = headers;
    return spec;
  }
  return skip("W_INVALID_ENTRY", "command", "command/url");
}

export async function readCodexConfig(file: string, retries: number): Promise<ServerSpec[]> {
  const r = await readParsed(
    file,
    (text) => {
      try {
        return codexToSpecs(parseToml(text));
      } catch (err) {
        if (err instanceof SourceError) throw err;
        throw new SourceError(file, "err.invalidToml", { detail: (err as Error).message.split("\n")[0] });
      }
    },
    retries,
  );
  return r ?? [];
}
