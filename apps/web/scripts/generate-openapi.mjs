#!/usr/bin/env node
/**
 * Generuje albo sprawdza aktualność opisu OpenAPI 3.1 API TimoTime (`openapi/timotime-api.json`).
 * Uruchamiany z katalogu głównego przez `pnpm openapi` lub `pnpm openapi:check`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { serializeOpenApiDocument } from "../src/server/openapi.ts";

const OUTPUT_PATH = resolve(import.meta.dirname, "../../../openapi/timotime-api.json");
const checkOnly = process.argv.includes("--check");
const expected = serializeOpenApiDocument();

if (checkOnly) {
  const actual = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, "utf8") : null;
  if (actual !== expected) {
    console.error("Plik openapi/timotime-api.json jest nieaktualny lub brakuje go. Uruchom: pnpm openapi");
    process.exit(1);
  }
  console.log("openapi/timotime-api.json jest aktualny.");
} else {
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, expected, "utf8");
  console.log("Zapisano openapi/timotime-api.json.");
}
