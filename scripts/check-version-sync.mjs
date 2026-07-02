// scripts/check-version-sync.mjs
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const srv = JSON.parse(readFileSync("server.json", "utf8"));
if (pkg.version !== srv.version) {
  console.error(`Version mismatch: package.json=${pkg.version} server.json=${srv.version}`);
  process.exit(1);
}
const nested = srv.packages?.[0]?.version;
if (nested !== srv.version) {
  console.error(`Version mismatch: server.json=${srv.version} server.json packages[0]=${nested}`);
  process.exit(1);
}
// The MCP registry rejects descriptions over 100 chars (422 at publish time).
if (srv.description.length > 100) {
  console.error(`server.json description is ${srv.description.length} chars; registry max is 100`);
  process.exit(1);
}
console.log(`Versions in sync: ${pkg.version}`);
