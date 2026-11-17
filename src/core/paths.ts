import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Paths {
  home: string;
  claudeJson: string;
  codexConfig: string;
  copilotDir: string;
  copilotConfig: string;
  lockFile: string;
}

export interface PathOptions {
  /** Explicit home folder. When set, CODEX_HOME / COPILOT_HOME are ignored. */
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

export function resolvePaths(opts: PathOptions = {}): Paths {
  const env = opts.env ?? process.env;
  const home = opts.home ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
  const codexDir = opts.home ? path.join(home, ".codex") : env.CODEX_HOME || path.join(home, ".codex");
  const copilotDir = opts.home
    ? path.join(home, ".copilot")
    : env.COPILOT_HOME || path.join(home, ".copilot");
  return {
    home,
    claudeJson: path.join(home, ".claude.json"),
    codexConfig: path.join(codexDir, "config.toml"),
    copilotDir,
    copilotConfig: path.join(copilotDir, "mcp-config.json"),
    lockFile: path.join(copilotDir, "mcp-unison.lock.json"),
  };
}

/** Normalise a project path for comparison with `~/.claude.json` project keys. */
export function normalizeProjectKey(p: string, platform: NodeJS.Platform = process.platform): string {
  let s = p.replace(/\\/g, "/");
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  if (platform === "darwin" || platform === "win32") s = s.toLowerCase();
  return s;
}

export interface LocalKeyMatch {
  key?: string;
  /** A key that looks like the same project but did not match exactly. */
  nearest?: string;
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Find the `projects` key that belongs to `projectDir`. When nothing matches exactly, a
 * `nearest` key is reported only if it plausibly is the same folder: it differs by case,
 * or the last folder name is the same but a parent folder differs (moved or renamed
 * parent). Sibling projects with similar names are never suggested.
 */
export function findLocalKey(
  keys: readonly string[],
  projectDir: string,
  platform: NodeJS.Platform = process.platform,
): LocalKeyMatch {
  const wanted = new Set([
    normalizeProjectKey(projectDir, platform),
    normalizeProjectKey(realpathOrSelf(projectDir), platform),
  ]);
  for (const key of keys) {
    if (wanted.has(normalizeProjectKey(key, platform))) return { key };
  }
  const target = normalizeProjectKey(projectDir, platform).toLowerCase();
  const targetBase = path.posix.basename(target);
  for (const key of keys) {
    const nk = normalizeProjectKey(key, platform).toLowerCase();
    if (nk === target || (targetBase !== "" && path.posix.basename(nk) === targetBase)) return { nearest: key };
  }
  return {};
}
