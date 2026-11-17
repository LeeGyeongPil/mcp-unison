/** Neutral model shared by every reader and writer. */
import { en, type MessageKey } from "../i18n/en";
import { format } from "../i18n/format";

export const WARNING_CODES = [
  "W_NAME_CONFLICT",
  "W_UNSET_VAR",
  "W_BLOCKED_SECRET_VAR",
  "W_URL_WITHOUT_TYPE",
  "W_SSE_UNSUPPORTED",
  "W_SSE_DEPRECATED",
  "W_TRANSPORT_UNSUPPORTED",
  "W_HEADERS_HELPER",
  "W_OAUTH_PARTIAL",
  "W_DISABLED",
  "W_INVALID_ENTRY",
  "W_URL_VAR_COPILOT",
  "W_LOCAL_SCOPE_NOT_FOUND",
  "W_COPILOT_ENTRY_EXISTS",
  "W_INPUT_VAR",
  "W_RESOLVED_PATH",
  "W_DROPPED_FIELD",
  "W_COMMAND_NOT_ON_PATH",
  "W_LOCAL_SCOPE_NOT_SYNCED",
] as const;

export type WarningCode = (typeof WARNING_CODES)[number];

export interface Warning {
  code: WarningCode;
  server: string;
  field?: string;
  detail?: string;
}

export type Origin =
  | "claude-user"
  | "claude-local"
  | "claude-project"
  | "codex";

export type Transport = "stdio" | "http" | "sse";

export interface ServerSpec {
  name: string;
  origin: Origin;
  transport: Transport;
  /** Values may still contain `${VAR}` references; they are never resolved here. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  oauthClientId?: string;
  /** Set when the server cannot be translated at all. */
  skipped?: WarningCode;
  warnings: Warning[];
}

export function isClaudeOrigin(o: Origin): boolean {
  return o !== "codex";
}

export function warningKey(w: Warning): string {
  return `${w.code}|${w.server}|${w.field ?? ""}|${w.detail ?? ""}`;
}

export function dedupeWarnings(list: Warning[]): Warning[] {
  const seen = new Set<string>();
  const out: Warning[] = [];
  for (const w of list) {
    const k = warningKey(w);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(w);
    }
  }
  return out;
}

export type SourceErrorKey = Extract<MessageKey, `err.${string}`>;
export type SourceErrorParams = Record<string, string | number | undefined>;

/**
 * Error raised for unreadable source files. The English `message` always names the
 * file; `key` and `params` let the CLI and the extension print it in the chosen language.
 */
export class SourceError extends Error {
  readonly file: string;
  readonly key: SourceErrorKey;
  readonly params: SourceErrorParams;
  constructor(file: string, key: SourceErrorKey, params: SourceErrorParams = {}) {
    super(format(en[key], { ...params, file }));
    this.name = "SourceError";
    this.file = file;
    this.key = key;
    this.params = { ...params, file };
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function stringRecord(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
    else if (typeof val === "number" || typeof val === "boolean") out[k] = String(val);
  }
  return out;
}
