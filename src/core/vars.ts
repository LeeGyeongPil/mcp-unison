/**
 * Variable semantics copied from Claude Code's documented behaviour
 * (https://code.claude.com/docs/en/mcp, checked 2026-11-17):
 *  - `${VAR}` / `${VAR:-default}` only (plain `$VAR` stays literal text).
 *  - An unset variable without default is left as the literal `${VAR}` text.
 *  - An empty string counts as a set value, so `${VAR:-d}` becomes "".
 *  - Remote servers (url / headers) read credential-like variables as "".
 */

export const DEFAULT_BLOCKED_VARS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "HTTPS_PROXY",
  "NPM_TOKEN",
];

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export interface ExpandOptions {
  /** True for `url` and `headers` of remote servers: blocked variables become "". */
  remote: boolean;
  blocked: ReadonlySet<string>;
}

export interface ExpandResult {
  value: string;
  /** Variables left as literal text because they were unset and had no default. */
  unset: string[];
  /** Blocked variables that were replaced by an empty string. */
  blocked: string[];
}

export function blockedSet(extra: readonly string[] = []): Set<string> {
  return new Set([...DEFAULT_BLOCKED_VARS, ...extra]);
}

export function hasVars(input: string): boolean {
  VAR_RE.lastIndex = 0;
  const found = VAR_RE.test(input);
  VAR_RE.lastIndex = 0;
  return found;
}

/** Resolve variables in memory using `env`. */
export function expand(
  input: string,
  env: Readonly<Record<string, string | undefined>>,
  opts: ExpandOptions,
): ExpandResult {
  const unset: string[] = [];
  const blocked: string[] = [];
  const value = input.replace(VAR_RE, (match, name: string, dflt?: string) => {
    if (opts.remote && opts.blocked.has(name)) {
      blocked.push(name);
      return "";
    }
    const v = env[name];
    if (v !== undefined) return v; // "" is a real value
    if (dflt !== undefined) return dflt;
    unset.push(name);
    return match;
  });
  return { value, unset, blocked };
}

/**
 * Mode B helper: keep every `${VAR}` reference as text (so no secret is written
 * to disk) but replace blocked variables with "" the way Claude Code would.
 */
export function blankBlocked(
  input: string,
  blocked: ReadonlySet<string>,
): { value: string; blocked: string[] } {
  const hits: string[] = [];
  const value = input.replace(VAR_RE, (match, name: string) => {
    if (blocked.has(name)) {
      hits.push(name);
      return "";
    }
    return match;
  });
  return { value, blocked: hits };
}
