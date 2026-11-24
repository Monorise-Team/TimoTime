import { definePermissions, type PermissionKeyOf } from "@monorise-team/permissions";

/**
 * Uprawnienia TimoTime deklarowane w kodzie produktu (ADR-0036, karta produktu TimoTime).
 * Manifest i gotowe role są rejestrowane w MonoriseCore poleceniem `pnpm permissions:register`.
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

export interface TimotimeRoleTemplate {
  readonly key: `timotime.${string}`;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly [TimotimePermissionKey, ...TimotimePermissionKey[]];
}

/**
 * Gotowe role (szablony) TimoTime wysyłane do MonoriseCore zaraz po manifeście uprawnień (ADR-0033, ADR-0036).
 */
export const TIMOTIME_ROLE_TEMPLATES = [
  {
    key: "timotime.employee",
    name: "Pracownik",
    description: "Rejestruje i przegląda własny czas pracy",
    permissions: [TIMOTIME_PERMISSIONS.keys["entries.read_own"], TIMOTIME_PERMISSIONS.keys["entries.write_own"]],
  },
  {
    key: "timotime.manager",
    name: "Kierownik",
    description: "Przegląda i zatwierdza czas pracy, urlopy i raporty zespołu w swoim zakresie",
    permissions: [
      TIMOTIME_PERMISSIONS.keys["entries.read_own"],
      TIMOTIME_PERMISSIONS.keys["entries.write_own"],
      TIMOTIME_PERMISSIONS.keys["entries.read"],
      TIMOTIME_PERMISSIONS.keys["entries.approve"],
      TIMOTIME_PERMISSIONS.keys["leave.approve"],
      TIMOTIME_PERMISSIONS.keys["reports.export"],
    ],
  },
] as const satisfies readonly TimotimeRoleTemplate[];
