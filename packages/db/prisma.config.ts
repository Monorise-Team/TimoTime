import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Prisma 7 nie czyta sam pliku .env. Lokalnie adres właściciela tabel (timo_time_owner) jest w packages/db/.env
// (pnpm setup:env), a w CI w zmiennej DATABASE_URL. Generowanie klienta nie potrzebuje bazy.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL },
});
