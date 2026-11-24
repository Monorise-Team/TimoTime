#!/usr/bin/env node
/**
 * Rejestruje manifest uprawnień oraz gotowe role (szablony) TimoTime w MonoriseCore.
 *
 * Czyta CORE_AUTH_URL, CORE_API_URL, TIMOTIME_OAUTH_CLIENT_ID i TIMOTIME_OAUTH_CLIENT_SECRET
 * ze środowiska, a lokalnie z fallbackiem do apps/web/.env.local (tworzonego przez pnpm setup:env).
 */
import { fileURLToPath } from "node:url";
import {
  formatRegistrationStep,
  registerWithCore,
  resolveRegistrationConfig,
} from "../src/server/core-registration.ts";

const envFilePath = fileURLToPath(new URL("../.env.local", import.meta.url));
const config = resolveRegistrationConfig(process.env, { envFilePath });

if (config.coreApiUrl) {
  console.log(`Rejestracja uprawnień i gotowych ról TimoTime w MonoriseCore (${config.coreApiUrl})...`);
}

try {
  await registerWithCore({
    ...config,
    onStep: (event) => {
      console.log(formatRegistrationStep(event));
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Rejestracja nie powiodła się: ${message}`);
  process.exit(1);
}
