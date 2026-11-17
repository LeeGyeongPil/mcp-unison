import { createHash } from "node:crypto";
import { isClaudeOrigin, type ServerSpec, type Warning } from "../model";
import { expand, type ExpandResult } from "../vars";

export interface StdioDef {
  kind: "stdio";
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  version: string;
}

export interface HttpDef {
  kind: "http";
  name: string;
  url: string;
  headers: Record<string, string>;
  version: string;
}

export type ProviderDef = StdioDef | HttpDef;

export interface ProviderOptions {
  blocked: ReadonlySet<string>;
  /** name -> reason. These names are already visible to the editor another way. */
  excludeNames?: ReadonlyMap<string, string>;
}

export interface ProviderResult {
  defs: ProviderDef[];
  warnings: Warning[];
  excluded: { name: string; reason: string }[];
}

function versionOf(def: object): string {
  return createHash("sha256").update(JSON.stringify(def)).digest("hex").slice(0, 12);
}

/**
 * Mode A: resolve variables in memory (never written anywhere) and build the
 * data the extension turns into `McpStdioServerDefinition` / `McpHttpServerDefinition`.
 */
export function toProviderDefs(
  servers: readonly ServerSpec[],
  env: Readonly<Record<string, string | undefined>>,
  opts: ProviderOptions,
): ProviderResult {
  const defs: ProviderDef[] = [];
  const warnings: Warning[] = [];
  const excluded: { name: string; reason: string }[] = [];

  for (const s of servers) {
    if (s.skipped) continue; // reader already reported why
    const reason = opts.excludeNames?.get(s.name);
    if (reason) {
      excluded.push({ name: s.name, reason });
      continue;
    }
    if (s.transport === "sse") {
      warnings.push({ code: "W_SSE_UNSUPPORTED", server: s.name, detail: s.url });
      continue;
    }

    const remote = s.transport === "http";
    const useBlocked = remote && isClaudeOrigin(s.origin);
    const local: Warning[] = [];
    const run = (value: string, field: string): string => {
      const r: ExpandResult = expand(value, env, { remote: useBlocked, blocked: opts.blocked });
      for (const v of r.unset) local.push({ code: "W_UNSET_VAR", server: s.name, field, detail: v });
      for (const v of r.blocked) local.push({ code: "W_BLOCKED_SECRET_VAR", server: s.name, field, detail: v });
      return r.value;
    };
    const runMap = (m: Record<string, string> | undefined, field: string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(m ?? {})) out[k] = run(v, `${field}.${k}`);
      return out;
    };

    let def: ProviderDef;
    if (s.transport === "stdio") {
      const base = {
        kind: "stdio" as const,
        name: s.name,
        command: run(s.command ?? "", "command"),
        args: (s.args ?? []).map((a, i) => run(a, `args[${i}]`)),
        env: runMap(s.env, "env"),
        ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
      };
      def = { ...base, version: versionOf(base) };
    } else {
      const base = {
        kind: "http" as const,
        name: s.name,
        url: run(s.url ?? "", "url"),
        headers: runMap(s.headers, "headers"),
      };
      def = { ...base, version: versionOf(base) };
    }
    warnings.push(...local);
    // A server with a literal ${VAR} left in it would send garbage, so it is not offered.
    if (local.some((w) => w.code === "W_UNSET_VAR")) continue;
    defs.push(def);
  }
  return { defs, warnings, excluded };
}
