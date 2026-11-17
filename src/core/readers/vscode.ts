import * as path from "node:path";
import { isRecord } from "../model";
import { parseJsonText, readTextIfExists } from "./util";

export interface VscodeMcpFile {
  file: string;
  text: string;
  servers: Record<string, Record<string, unknown>>;
  inputs: unknown[];
}

export function parseVscodeMcp(text: string, file: string): VscodeMcpFile {
  const root = parseJsonText(text, file, true);
  const servers: Record<string, Record<string, unknown>> = {};
  if (isRecord(root) && isRecord(root.servers)) {
    for (const [name, v] of Object.entries(root.servers)) {
      if (isRecord(v)) servers[name] = v;
    }
  }
  const inputs = isRecord(root) && Array.isArray(root.inputs) ? root.inputs : [];
  return { file, text, servers, inputs };
}

/** `.vscode/mcp.json` (JSONC) of the workspace. */
export function readVscodeMcp(projectDir: string): VscodeMcpFile | undefined {
  const file = path.join(projectDir, ".vscode", "mcp.json");
  const text = readTextIfExists(file);
  return text === undefined ? undefined : parseVscodeMcp(text, file);
}
