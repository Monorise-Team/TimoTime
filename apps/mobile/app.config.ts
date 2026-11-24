import type { ExpoConfig } from "expo/config";
import pkg from "./package.json";

/**
 * Wersja aplikacji to wersja TimoTime z package.json (ADR-0087: jedna wersja wszystkich części). Numer
 * kompilacji dla App Store i Google Play wyliczamy z niej: 1.2.3 → 10203, więc zawsze rośnie razem z wersją.
 */
const [major = 0, minor = 0, patch = 0] = pkg.version.split(/[.-]/).map(Number);
const build = major * 10_000 + minor * 100 + patch;

const config: ExpoConfig = {
  name: "TimoTime",
  slug: "timotime",
  scheme: "timotime",
  version: pkg.version,
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: "studio.monorise.timotime",
    buildNumber: String(build),
    supportsTablet: true,
  },
  android: {
    package: "studio.monorise.timotime",
    versionCode: build,
  },
  extra: {
    /** Adres serwera TimoTime, z którym łączy się telefon (symulator iOS: 127.0.0.1). */
    apiUrl: process.env.EXPO_PUBLIC_TIMOTIME_API ?? "http://127.0.0.1:3300",
    /** Identyfikator API TimoTime w Core (odbiorca tokenów); na produkcji równy adresowi API. */
    apiResource: process.env.EXPO_PUBLIC_TIMOTIME_API_RESOURCE ?? "http://time.localhost:3300",
    /** Serwer logowania MonoriseCore. */
    coreAuthUrl: process.env.EXPO_PUBLIC_CORE_AUTH_URL ?? "http://localhost:3100",
    /** Core API (dane osoby i firmy); na produkcji https://api.monorise.studio. */
    coreApiUrl: process.env.EXPO_PUBLIC_CORE_API_URL ?? "http://localhost:3200",
  },
};

export default config;
