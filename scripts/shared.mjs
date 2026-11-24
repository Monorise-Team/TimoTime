#!/usr/bin/env node
/**
 * Wspólne aktualizowanie bibliotek @monorise-team/* (ADR-0087): wszystkie paczki w TimoTime zawsze w jednej
 * wersji. Renovate robi to samo co tydzień przez pull request; ten skrypt służy do ręcznej aktualizacji.
 *
 *   pnpm shared:update            najnowsza wersja stabilna (oznaczenie latest)
 *   pnpm shared:update dev        najnowsza wersja testowa z gałęzi dev MonoriseShared
 *   pnpm shared:update 0.2.0      konkretna wersja
 *
 * Wymaga tokenu do GitHub Packages w zmiennej GITHUB_PACKAGES_TOKEN (zob. README).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const [command, target = "latest"] = process.argv.slice(2);
if (command !== "update") {
  console.error("Użycie: node scripts/shared.mjs update [latest|dev|<wersja>]");
  process.exit(2);
}

const version = /^\d+\.\d+\.\d+/.test(target)
  ? target
  : execFileSync("pnpm", ["view", `@monorise-team/config@${target}`, "version"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
if (!version) throw new Error(`Nie znaleziono wersji @monorise-team/* dla „${target}”`);

const files = [
  "package.json",
  ...["apps", "packages"].flatMap((dir) => readdirSync(join(root, dir)).map((name) => `${dir}/${name}/package.json`)),
];
let changed = 0;
for (const file of files) {
  const path = join(root, file);
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  let touched = false;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (name.startsWith("@monorise-team/") && pkg[field][name] !== version) {
        pkg[field][name] = version;
        touched = true;
      }
    }
  }
  if (touched) {
    writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
    changed += 1;
  }
}
console.log(`@monorise-team/* → ${version} (${changed} plików). Teraz: pnpm install && pnpm check`);
