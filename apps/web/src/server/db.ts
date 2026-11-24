import "server-only";
import { createDb, type PrismaClient } from "@timotime/db";
import { config } from "./config";

const globalForDb = globalThis as unknown as { timotimeDb?: PrismaClient };

/**
 * Baza timo_time (PostgreSQL, ADR-0096). Serwer łączy się rolą timo_time_app, więc wpisy czasu pracy
 * są dostępne tylko przez withUser z @timotime/db (RLS, ADR-0037). Jedna pula połączeń na proces,
 * także po przeładowaniu modułów w trybie deweloperskim.
 */
export function getDb(): PrismaClient {
  if (!config.databaseUrl) throw new Error("Brak DATABASE_URL (lokalnie: pnpm setup:env, pnpm db:up, pnpm db:migrate)");
  globalForDb.timotimeDb ??= createDb(config.databaseUrl);
  return globalForDb.timotimeDb;
}
