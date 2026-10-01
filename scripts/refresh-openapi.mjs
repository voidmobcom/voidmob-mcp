#!/usr/bin/env node
// Refreshes tests/fixtures/openapi.json, the dashboard's bundled public API
// spec that tests/contract.test.ts checks every MCP request against.
//
//   node scripts/refresh-openapi.mjs [path-to-openapi.json]
//
// Default source: ../vm-dashboard/public/openapi.json (a vm-dashboard checkout
// next to this repo). Reads a local file only; it never calls the API.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(process.argv[2] ?? join(root, "../vm-dashboard/public/openapi.json"));
const dest = join(root, "tests/fixtures/openapi.json");

const text = readFileSync(src, "utf8");
const spec = JSON.parse(text);
if (typeof spec.openapi !== "string" || !spec.paths || Object.keys(spec.paths).length === 0) {
  console.error(`${src} does not look like an OpenAPI document`);
  process.exit(1);
}
writeFileSync(dest, text);
console.log(`tests/fixtures/openapi.json <- ${src} (OpenAPI ${spec.openapi}, ${Object.keys(spec.paths).length} paths)`);
