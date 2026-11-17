// Checks the packaged extension: required files present, test and demo files absent.
// Usage: npm run package && node scripts/check-vsix.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const vsixName = `${pkg.name}-${pkg.version}.vsix`;

function fail(message) {
  console.error(`vsix check failed: ${message}`);
  process.exit(1);
}

if (!existsSync(join(root, vsixName))) fail(`${vsixName} not found. Run "npm run package" first.`);

// `vsce ls` prints the files that go into the package, one per line.
const vsce = join(root, "node_modules", ".bin", process.platform === "win32" ? "vsce.cmd" : "vsce");
const files = execFileSync(vsce, ["ls", "--no-yarn"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .map((l) => l.trim().replace(/\\/g, "/"))
  .filter(Boolean);

const required = ["out/src/extension.js", "package.nls.json", "package.nls.ko.json", "package.json"];
for (const f of required) if (!files.includes(f)) fail(`missing ${f}`);
if (!files.some((f) => f.startsWith("node_modules/smol-toml/"))) fail("missing node_modules/smol-toml");
if (!files.some((f) => f.startsWith("node_modules/jsonc-parser/"))) fail("missing node_modules/jsonc-parser");

for (const prefix of ["test/", "out/test/", "examples/", ".vscode-test/", "scripts/", ".github/"]) {
  const hit = files.find((f) => f.startsWith(prefix));
  if (hit) fail(`${hit} must not be packaged`);
}
if (files.some((f) => f.endsWith(".vsix"))) fail("a .vsix file would be nested in the package");

console.log(`${vsixName}: ${files.length} files`);
console.log("vsix ok");
