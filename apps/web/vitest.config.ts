import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Moduły tylko dla serwera: w testach nie ma podziału na klienta i serwer
      "server-only": fileURLToPath(new URL("./test/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Klucz „Core” do podpisywania tokenów w testach (TIMOTIME_CORE_JWKS)
    setupFiles: ["./test/setup.ts"],
    env: {
      // Prawdziwy PostgreSQL (pnpm db:up && pnpm db:migrate albo usługa w CI), rola aplikacji z RLS
      DATABASE_URL:
        process.env.TIMOTIME_TEST_APP_DATABASE_URL ??
        "postgresql://timo_time_app:timo_time_app@localhost:5435/timo_time_test",
      TIMOTIME_SESSION_SECRET: "sekret-sesji-tylko-do-testow-ma-ponad-32-znaki",
      TIMOTIME_OAUTH_CLIENT_SECRET: "sekret-klienta-tylko-do-testow",
    },
  },
});
