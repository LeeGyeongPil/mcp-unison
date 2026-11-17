/* eslint-disable @typescript-eslint/no-explicit-any */
// A tiny stand-in for the `vscode` module, enough to run activate() without the editor.
// Real-editor checks live in test/integration (CI only).
import Module = require("node:module");

export interface Shim {
  api: any;
  providers: Map<string, any>;
  commands: Map<string, (...a: any[]) => any>;
  config: Record<string, unknown>;
  updates: { key: string; value: unknown; target: unknown }[];
  messages: { kind: string; text: string; items: unknown[] }[];
  diffs: unknown[][];
  documents: { content: string; language: string }[];
  /** Answers handed to the next prompts. */
  answers: { message?: string; quickPick?: unknown };
  folders: { uri: { fsPath: string } }[];
  language: string;
}

export function createShim(): Shim {
  const shim: Shim = {
    api: undefined,
    providers: new Map(),
    commands: new Map(),
    config: {},
    updates: [],
    messages: [],
    diffs: [],
    documents: [],
    answers: {},
    folders: [],
    language: "en",
  };

  class EventEmitter<T> {
    private listeners: ((e: T) => void)[] = [];
    event = (l: (e: T) => void): { dispose(): void } => {
      this.listeners.push(l);
      return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
    };
    fire(e: T): void {
      for (const l of [...this.listeners]) l(e);
    }
    dispose(): void {
      this.listeners = [];
    }
  }

  class McpStdioServerDefinition {
    cwd: unknown;
    constructor(
      public label: string,
      public command: string,
      public args: string[] = [],
      public env: Record<string, unknown> = {},
      public version?: string,
    ) {}
  }
  class McpHttpServerDefinition {
    constructor(
      public label: string,
      public uri: { toString(): string },
      public headers: Record<string, string> = {},
      public version?: string,
    ) {}
  }

  const notify = (kind: string) => async (text: string, ...items: unknown[]) => {
    shim.messages.push({ kind, text, items });
    const wanted = shim.answers.message;
    const flat = items.filter((i) => typeof i === "string");
    return wanted !== undefined && flat.includes(wanted) ? wanted : undefined;
  };

  shim.api = {
    EventEmitter,
    McpStdioServerDefinition,
    McpHttpServerDefinition,
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    Uri: {
      file: (p: string) => ({ fsPath: p, scheme: "file", toString: () => `file://${p}` }),
      parse: (s: string) => ({ fsPath: s, toString: () => s }),
    },
    env: {
      get language() {
        return shim.language;
      },
    },
    lm: {
      registerMcpServerDefinitionProvider: (id: string, provider: unknown) => {
        shim.providers.set(id, provider);
        return { dispose: () => shim.providers.delete(id) };
      },
    },
    commands: {
      registerCommand: (id: string, fn: (...a: any[]) => any) => {
        shim.commands.set(id, fn);
        return { dispose: () => shim.commands.delete(id) };
      },
      executeCommand: async (id: string, ...args: any[]) => {
        if (id === "vscode.diff") {
          shim.diffs.push(args);
          return undefined;
        }
        const fn = shim.commands.get(id);
        if (!fn) throw new Error(`unknown command ${id}`);
        return fn(...args);
      },
    },
    workspace: {
      get workspaceFolders() {
        return shim.folders.length > 0 ? shim.folders : undefined;
      },
      getConfiguration: (_section: string) => ({
        get: (key: string, dflt?: unknown) => (key in shim.config ? shim.config[key] : dflt),
        update: async (key: string, value: unknown, target: unknown) => {
          shim.updates.push({ key, value, target });
          shim.config[key] = value;
        },
      }),
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      openTextDocument: async (opts: { content: string; language: string }) => {
        shim.documents.push(opts);
        return opts;
      },
    },
    window: {
      showInformationMessage: notify("info"),
      showWarningMessage: notify("warn"),
      showQuickPick: async () => shim.answers.quickPick,
      showTextDocument: async () => undefined,
    },
  };
  return shim;
}

/** Make `require("vscode")` return the shim. Call before loading out/src/extension.js. */
export function installShim(shim: Shim): () => void {
  const M = Module as any;
  const original = M._load;
  M._load = function (request: string, ...rest: unknown[]) {
    if (request === "vscode") return shim.api;
    return original.call(this, request, ...rest);
  };
  return () => {
    M._load = original;
  };
}
