import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Repository root (this file compiles to out/test/helpers.js). */
export const ROOT = path.resolve(__dirname, "..", "..");
export const CLI = path.join(ROOT, "out", "src", "cli.js");

/** Anything with an after() hook: a test context, or a small adapter for before(). */
export interface Cleaner {
  after(fn: () => void): void;
}

/** A temp folder that is removed after the test. Tests never touch the real home. */
export function tmpDir(t: Cleaner, label = "t"): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `mcp-unison-${label}-`)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function writeTree(root: string, files: Record<string, string | object>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
  }
}

/** Copy the practice mock home; the local scope key is pointed at the copy. */
export function copyDemo(t: Cleaner): { home: string; project: string } {
  const home = tmpDir(t, "demo");
  fs.cpSync(path.join(ROOT, "examples", "demo-home"), home, { recursive: true });
  const project = path.join(home, "project");
  const claude = path.join(home, ".claude.json");
  fs.writeFileSync(
    claude,
    fs.readFileSync(claude, "utf8").split("__DEMO_PROJECT__").join(JSON.stringify(project).slice(1, -1)),
  );
  return { home, project };
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the compiled CLI with a clean environment (only PATH plus what the test passes). */
export function runCli(args: string[], env: Record<string, string> = {}, cwd?: string): RunResult {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd,
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
