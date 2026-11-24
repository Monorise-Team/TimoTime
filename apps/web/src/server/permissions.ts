import "server-only";
import { TIMOTIME_PERMISSIONS, type TimotimePermissionKey } from "@timotime/contracts";
import { ApiFailure } from "./api";
import type { Caller } from "./auth";

const SELF_SERVICE_PERMISSIONS = new Set<TimotimePermissionKey>([
  TIMOTIME_PERMISSIONS.keys["entries.read_own"],
  TIMOTIME_PERMISSIONS.keys["entries.write_own"],
]);

/**
 * Jedyny punkt sprawdzania uprawnień po stronie serwera TimoTime.
 *
 * W pierwszej wersji Core nie wydaje jeszcze migawki uprawnień (etap 2 Core), więc zalogowana osoba
 * może wyłącznie odczytywać i zapisywać własne wpisy (dodatkowo wymuszone przez RLS w bazie).
 * Po wdrożeniu migawek w Core tutaj podepniemy `can(snapshot, permission, target)` z `@monorise-team/permissions`.
 */
export function assertTimePermission(_caller: Caller, permission: TimotimePermissionKey): void {
  if (!SELF_SERVICE_PERMISSIONS.has(permission)) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do tej operacji");
  }
}
