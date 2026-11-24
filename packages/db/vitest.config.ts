import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Testy pracują na prawdziwym PostgreSQL (docker compose albo usługa w CI), jeden plik naraz
    fileParallelism: false,
  },
});
