import * as fs from "node:fs";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { SourceError } from "../model";

export function lineCol(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, col: offset - last };
}

/** Parse JSON (or JSONC when `allowComments`). Errors name the file and line. */
export function parseJsonText(text: string, file: string, allowComments = false): unknown {
  if (!allowComments) {
    try {
      return JSON.parse(text);
    } catch {
      /* fall through to get a precise position */
    }
  }
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, {
    allowTrailingComma: allowComments,
    disallowComments: !allowComments,
  });
  if (errors.length > 0) {
    const e = errors[0];
    const { line, col } = lineCol(text, e.offset);
    throw new SourceError(file, "err.invalidJson", { line, col, detail: printParseErrorCode(e.error) });
  }
  return value;
}

/** Read a UTF-8 file; returns undefined when it does not exist. */
export function readTextIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SourceError(file, "err.cannotRead", { detail: (err as Error).message });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Read + parse with retries. Claude Code rewrites its state file often, so a
 * parse error can simply mean we caught it mid-write.
 */
export async function readParsed<T>(
  file: string,
  parse: (text: string) => T,
  retries: number,
  delayMs = 100,
): Promise<T | undefined> {
  for (let attempt = 0; ; attempt++) {
    const text = readTextIfExists(file);
    if (text === undefined) return undefined;
    try {
      return parse(text);
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(delayMs);
    }
  }
}
