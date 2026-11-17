import type { SourceError, Warning } from "../core/model";
import { en, type MessageKey } from "./en";
import { format } from "./format";
import { ko } from "./ko";

export type Lang = "en" | "ko";

export const messages: Record<Lang, Record<MessageKey, string>> = { en, ko };

export function isLang(v: unknown): v is Lang {
  return v === "en" || v === "ko";
}

export { format };

export function t(lang: Lang, key: MessageKey, params?: Record<string, string | number | undefined>): string {
  return format(messages[lang][key], params);
}

export interface LangInput {
  /** Value of `--lang`. */
  flag?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

/** `--lang` > MCP_UNISON_LANG > LC_ALL > LC_MESSAGES > LANG. Anything but Korean is English. */
export function resolveLang(input: LangInput = {}): Lang {
  if (isLang(input.flag)) return input.flag;
  const env = input.env ?? process.env;
  if (isLang(env.MCP_UNISON_LANG)) return env.MCP_UNISON_LANG;
  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const v = env[key];
    if (v) return v.toLowerCase().startsWith("ko") ? "ko" : "en";
  }
  return "en";
}

/** Extension: setting (auto|en|ko) > editor display language. */
export function resolveExtLang(setting: string | undefined, editorLanguage: string | undefined): Lang {
  if (isLang(setting)) return setting;
  return (editorLanguage ?? "en").toLowerCase().startsWith("ko") ? "ko" : "en";
}

export function warningMessage(lang: Lang, w: Warning): string {
  return t(lang, `w.${w.code}` as MessageKey, { server: w.server, field: w.field, detail: w.detail });
}

/** A source file error in the chosen language (the English `message` stays for logs). */
export function sourceErrorMessage(lang: Lang, err: SourceError): string {
  return t(lang, err.key, err.params);
}
