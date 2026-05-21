// scripts/check-version-sync.mjs
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const srv = JSON.parse(readFileSync("server.json", "utf8"));
if (pkg.version !== srv.version) {
  console.error(`Version mismatch: package.json=${pkg.version} server.json=${srv.version}`);
  process.exit(1);
}
console.log(`Versions in sync: ${pkg.version}`);
