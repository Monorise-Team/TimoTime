import "server-only";

const list = (value: string | undefined, fallback = "") =>
  (value ?? fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/** Ustawienia serwera ze zmiennych środowiskowych (lokalnie `.env.local`, tworzy go `pnpm setup:env`). */
export const config = {
  /** Baza timo_time, rola aplikacji timo_time_app (bez omijania RLS). */
  get databaseUrl() {
    return process.env.DATABASE_URL ?? "";
  },
  /** Dodatkowe adresy aplikacji, które mogą wołać API z tokenem. */
  get allowedOrigins() {
    return list(process.env.TIMOTIME_ALLOWED_ORIGINS);
  },

  // ── Logowanie przez MonoriseCore (ADR-0095) ────────────────────────────────────────────────────────
  /** Serwer logowania Core (wystawca tokenów), np. https://auth.monorise.studio. */
  get coreAuthUrl() {
    return process.env.CORE_AUTH_URL ?? "http://localhost:3100";
  },
  /** Core API, np. https://api.monorise.studio. */
  get coreApiUrl() {
    return process.env.CORE_API_URL ?? "http://localhost:3200";
  },
  /** Aplikacja w przeglądarce (BFF), np. https://timo-time.monorise.studio. */
  get appUrl() {
    return process.env.TIMOTIME_APP_URL ?? "http://timo-time.localhost:3300";
  },
  /** API TimoTime, odbiorca tokenów z Core, np. https://time.monorise.studio. */
  get apiUrl() {
    return process.env.TIMOTIME_API_URL ?? "http://time.localhost:3300";
  },
  get oauthClientId() {
    return process.env.TIMOTIME_OAUTH_CLIENT_ID ?? "timotime-web";
  },
  /** Sekret klienta z Core (lokalnie z `pnpm oauth:seed` w MonoriseCore). */
  get oauthClientSecret() {
    return process.env.TIMOTIME_OAUTH_CLIENT_SECRET ?? "";
  },
  /** Sekret szyfrujący sesje (co najmniej 32 znaki); przy wymianie „nowy,stary”. */
  get sessionSecrets() {
    return list(process.env.TIMOTIME_SESSION_SECRET);
  },
  /** Klucze publiczne Core wpisane na stałe (JWKS w JSON) zamiast pobierania z Core: testy. */
  get coreJwks() {
    return process.env.TIMOTIME_CORE_JWKS ?? "";
  },
};
