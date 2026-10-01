// Packs voidmob-mcp.mcpb, the Claude Desktop bundle (MCPB): the built server,
// its production dependencies, the agent skill (served as resources) and
// manifest.json. Run through `npm run pack:mcpb`, which builds first.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";

const STAGE = ".mcpb-stage";
const OUT = "voidmob-mcp.mcpb";
const FILES = ["dist", "skills", "manifest.json", "package.json", "package-lock.json", "README.md", "LICENSE"];

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`manifest.json version ${manifest.version} does not match package.json ${pkg.version}`);
  process.exit(1);
}
if (!existsSync("dist/index.js")) {
  console.error("dist/ is missing - run npm run build first");
  process.exit(1);
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", timeout: 300_000, ...opts });
const mcpb = "node_modules/.bin/mcpb";

rmSync(STAGE, { recursive: true, force: true });
rmSync(OUT, { force: true });
mkdirSync(STAGE);
try {
  for (const f of FILES) cpSync(f, `${STAGE}/${f}`, { recursive: true });
  // Production dependencies only; no install scripts (nothing to build here).
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: STAGE });
  run(mcpb, ["validate", `${STAGE}/manifest.json`]);
  run(mcpb, ["pack", STAGE, OUT]);
} finally {
  rmSync(STAGE, { recursive: true, force: true });
}
console.log(`${OUT} (${pkg.version})`);
