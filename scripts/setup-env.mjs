#!/usr/bin/env node
/**
 * Ustawienia do pracy lokalnej:
 * - apps/web/.env.local: sekret sesji, baza (rola aplikacji), adresy MonoriseCore i sekret klienta
 *   timotime-web z Core (z pliku, który zapisuje `pnpm oauth:seed` w MonoriseCore),
 * - packages/db/.env: baza dla migracji (właściciel tabel).
 * Istniejących wartości nie zmienia: dopisuje tylko brakujące.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const coreSecretsFile =
  process.env.CORE_OAUTH_SECRETS_FILE ?? join(root, "../MonoriseCore/apps/auth/.data/oauth-clients.json");
const coreSecret = existsSync(coreSecretsFile)
  ? (JSON.parse(readFileSync(coreSecretsFile, "utf8"))["timotime-web"] ?? "")
  : "";

function ensure(file, header, values) {
  const path = join(root, file);
  const current = existsSync(path) ? readFileSync(path, "utf8") : `${header}\n`;
  const present = new Set(current.split("\n").map((line) => line.split("=")[0]?.trim()));
  const added = Object.entries(values).filter(([key]) => !present.has(key));
  if (added.length) {
    const text = `${current.replace(/\n*$/, "\n")}${added.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
    writeFileSync(path, text, { mode: 0o600 });
  }
  console.log(added.length ? `${file}: dopisano ${added.map(([key]) => key).join(", ")}` : `${file}: bez zmian`);
  return path;
}

ensure("apps/web/.env.local", "# Tylko lokalnie. Nigdy nie commituj tego pliku.", {
  TIMOTIME_SESSION_SECRET: randomBytes(32).toString("base64url"),
  TIMOTIME_APP_URL: "http://timo-time.localhost:3300",
  TIMOTIME_API_URL: "http://time.localhost:3300",
  DATABASE_URL: "postgresql://timo_time_app:timo_time_app@localhost:5435/timo_time",
  CORE_AUTH_URL: "http://localhost:3100",
  CORE_API_URL: "http://localhost:3200",
  TIMOTIME_OAUTH_CLIENT_ID: "timotime-web",
  TIMOTIME_OAUTH_CLIENT_SECRET: coreSecret,
});
ensure("packages/db/.env", "# Tylko lokalnie: właściciel tabel, do migracji.", {
  DATABASE_URL: "postgresql://timo_time_owner:timo_time_owner@localhost:5435/timo_time",
});
if (!coreSecret) {
  console.log(
    "Brak sekretu klienta timotime-web: uruchom `pnpm oauth:seed` w MonoriseCore, potem jeszcze raz `pnpm setup:env`\n" +
      "(albo usuń pusty wpis TIMOTIME_OAUTH_CLIENT_SECRET z apps/web/.env.local, żeby skrypt mógł go dopisać).",
  );
}
