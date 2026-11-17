// Starts a real VS Code with the extension loaded. CI only (needs a display, for example xvfb).
// Locally: npm run test:integration (not part of `npm test`).
// On failure it prints what is needed to find the cause from the CI log alone: the editor
// version, system libraries the editor is missing, and the tail of the editor's own logs.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const CACHE = path.join(ROOT, ".vscode-test");
// The test editor's own profile; its log files end up in <USER_DATA>/logs.
const USER_DATA = path.join(CACHE, "user-data");
const LOGS = path.join(USER_DATA, "logs");
// Stop before the CI step's own timeout, which would end the job without any diagnostics.
const TIME_LIMIT_MS = Number(process.env.MCP_UNISON_IT_TIME_LIMIT_MS) || 6 * 60_000;

function log(line: string): void {
  console.log(`[integration] ${line}`);
}

/** Linux only: shared libraries the editor binary needs but the machine does not have. */
function missingLibraries(executable: string): string[] {
  if (process.platform !== "linux") return [];
  const r = spawnSync("ldd", [executable], { encoding: "utf8" });
  return (r.stdout ?? "")
    .split("\n")
    .filter((l) => l.includes("not found"))
    .map((l) => l.trim());
}

/** Prints the end of every log file of the newest editor session (main, window, extension host). */
function printEditorLogs(): void {
  const sessions = fs.existsSync(LOGS) ? fs.readdirSync(LOGS).sort() : [];
  const newest = sessions.at(-1);
  if (!newest) {
    log(`no editor logs under ${LOGS} (the editor probably did not start)`);
    return;
  }
  const dir = path.join(LOGS, newest);
  const files = fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".log"));
  for (const file of files.sort()) {
    const text = fs.readFileSync(path.join(dir, file), "utf8").trimEnd();
    if (text === "") continue;
    const lines = text.split("\n");
    console.log(`----- editor log ${newest}/${file} (last ${Math.min(lines.length, 60)} of ${lines.length} lines)`);
    console.log(lines.slice(-60).join("\n"));
  }
}

/** Kills editor processes started from .vscode-test after a time-out (reads /proc; skipped elsewhere). */
function stopEditor(): void {
  let pids: string[];
  try {
    pids = fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {
    return; // no /proc (macOS, Windows): the CI step timeout is the fallback
  }
  for (const pid of pids) {
    try {
      if (fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(CACHE)) process.kill(Number(pid), "SIGKILL");
    } catch {
      // the process already ended or belongs to someone else
    }
  }
}

/** Rejects (and stops the editor) when `work` takes longer than `ms`. */
async function withTimeLimit<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stopEditor();
      reject(new Error(`the editor did not finish within ${ms / 1000} s`));
    }, ms);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  log(`node ${process.version} on ${process.platform}-${process.arch}, DISPLAY=${process.env.DISPLAY ?? "(not set)"}`);

  // 1. A throwaway copy of the practice home folder; the local scope key points at its project.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-unison-it-"));
  fs.cpSync(path.join(ROOT, "examples", "demo-home"), fakeHome, { recursive: true });
  const project = path.join(fakeHome, "project");
  const claude = path.join(fakeHome, ".claude.json");
  const escaped = JSON.stringify(project).slice(1, -1); // the key sits inside a JSON string
  fs.writeFileSync(claude, fs.readFileSync(claude, "utf8").split("__DEMO_PROJECT__").join(escaped));

  try {
    // 2. The newest stable VS Code that satisfies engines.vscode (kept in .vscode-test).
    const executable = await downloadAndUnzipVSCode({ cachePath: CACHE, extensionDevelopmentPath: ROOT });
    log(`editor: ${executable}`);
    const missing = missingLibraries(executable);
    if (missing.length > 0) log(`the editor is missing system libraries:\n  ${missing.join("\n  ")}`);

    // 3. Open the practice project and run suite.ts inside the extension host. test-electron
    //    already adds --no-sandbox, --disable-gpu-sandbox and --disable-workspace-trust.
    const run = runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: ROOT,
      extensionTestsPath: path.join(__dirname, "suite"),
      launchArgs: [
        project,
        "--disable-extensions",
        "--disable-gpu",
        `--user-data-dir=${USER_DATA}`,
        `--extensions-dir=${path.join(CACHE, "extensions")}`,
      ],
      // Only suite.ts reads this variable. The editor itself keeps the runner's real HOME.
      extensionTestsEnv: { MCP_UNISON_TEST_HOME: fakeHome },
    });
    await withTimeLimit(run, TIME_LIMIT_MS);
    log("passed");
  } catch (err) {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    printEditorLogs();
    throw err;
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
}

// Exit explicitly so a leftover handle (download agent, spinner) cannot keep the CI step running.
main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
