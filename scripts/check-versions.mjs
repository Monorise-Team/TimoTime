#!/usr/bin/env node
/**
 * Jedna wersja wszystkich części TimoTime (ADR-0087). Release Please wpisuje wersję z package.json
 * w katalogu głównym do każdej części; ten skrypt odrzuca każdą rozbieżność (hook przed commitem i CI):
 *
 * - package.json każdej aplikacji i paczki,
 * - .release-please-manifest.json,
 * - wszystkie @monorise-team/* w jednej, dokładnej wersji (wspólne biblioteki też mają jedną wersję).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const { version } = json("package.json");
const problems = [];

const manifest = json(".release-please-manifest.json")["."];
if (manifest !== version) problems.push(`.release-please-manifest.json: ${manifest}, a package.json: ${version}`);

const workspaces = ["apps", "packages"].flatMap((dir) => readdirSync(join(root, dir)).map((name) => `${dir}/${name}`));
const shared = new Map();
for (const dir of ["", ...workspaces]) {
  const file = dir ? `${dir}/package.json` : "package.json";
  const pkg = json(file);
  if (dir && pkg.version !== version) problems.push(`${file}: wersja ${pkg.version}, a TimoTime ${version}`);
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (!name.startsWith("@monorise-team/")) continue;
      if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(range))
        problems.push(`${file}: ${name} ma zakres ${range}, a powinien dokładną wersję`);
      shared.set(range, [...(shared.get(range) ?? []), `${file} (${name})`]);
    }
  }
}
if (shared.size > 1) {
  problems.push(
    `@monorise-team/* w różnych wersjach: ${[...shared.entries()].map(([range, where]) => `${range} w ${where.join(", ")}`).join("; ")}. Uruchom: pnpm shared:update`,
  );
}

if (problems.length) {
  console.error(`Wersje TimoTime się rozjechały:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `Wersje zgodne: TimoTime ${version} we wszystkich ${workspaces.length} częściach, @monorise-team/* ${[...shared.keys()][0] ?? "-"}`,
);
