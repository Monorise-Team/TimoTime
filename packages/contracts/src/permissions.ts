import { definePermissions, type PermissionKeyOf } from "@monorise-team/permissions";

/**
 * Uprawnienia TimoTime deklarowane w kodzie produktu (ADR-0036, karta produktu TimoTime).
 * Manifest trafi do rejestracji w MonoriseCore w kolejnym etapie (etap 2 Core).
 */
export const TIMOTIME_PERMISSIONS = definePermissions("timotime", {
  "entries.read_own": "Odczyt własnych wpisów czasu pracy",
  "entries.write_own": "Rejestracja własnego czasu pracy",
  "entries.read": "Podgląd wpisów czasu pracy pracowników w zakresie uprawnień",
  "entries.approve": "Zatwierdzanie i odrzucanie poprawek wpisów czasu pracy",
  "leave.approve": "Zatwierdzanie i odrzucanie wniosków urlopowych",
  "reports.export": "Eksport raportów czasu pracy",
});

export const TIMOTIME_PERMISSION_MANIFEST = TIMOTIME_PERMISSIONS.manifest;

export type TimotimePermissionKey = PermissionKeyOf<typeof TIMOTIME_PERMISSIONS>;
