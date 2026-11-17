import { isRecord } from "../model";
import { parseJsonText, readParsed } from "./util";

export type CopilotEntry = Record<string, unknown>;

export interface CopilotFile {
  file: string;
  /** Original text, kept so a write can leave unrelated bytes alone. */
  text: string;
  entries: Record<string, CopilotEntry>;
}

export function parseCopilot(text: string, file: string): CopilotFile {
  const root = parseJsonText(text, file, true);
  const entries: Record<string, CopilotEntry> = {};
  if (isRecord(root) && isRecord(root.mcpServers)) {
    for (const [name, v] of Object.entries(root.mcpServers)) {
      if (isRecord(v)) entries[name] = v;
    }
  }
  return { file, text, entries };
}

export async function readCopilot(file: string, retries: number): Promise<CopilotFile | undefined> {
  return readParsed(file, (t) => parseCopilot(t, file), retries);
}
