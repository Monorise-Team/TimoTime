import "server-only";
import {
  can,
  createPermissionCache,
  scopeOf,
  type AccessScope,
  type PermissionCacheFilter,
  type PermissionSnapshot,
} from "@monorise-team/permissions";
import { TIMOTIME_PERMISSIONS, type Capabilities, type TimotimePermissionKey } from "@timotime/contracts";
import { ApiFailure } from "./api";
import type { Caller } from "./auth";
import { getMachineCoreClient } from "./core";

/**
 * Komunikat zwracany, gdy produkt `timotime` nie znajduje się w `snapshot.products` (brak dostępu firmy
 * albo brak włączonego TimoTime na koncie; z samej migawki nie da się tych sytuacji rozróżnić).
 */
export const PRODUCT_ACCESS_REQUIRED_MESSAGE =
  "TimoTime nie jest włączony dla Twojego konta. Poproś Ownera firmy o dostęp.";

type PermissionCache = ReturnType<typeof createPermissionCache>;

/**
 * Jedna pamięć na proces. Next.js wczytuje `instrumentation.ts` (pobieranie zdarzeń z Core) i trasy API
 * jako osobne kopie modułów, więc zwykła zmienna modułu dałaby dwie różne pamięci: zdarzenie czyściłoby
 * nie tę, z której korzystają trasy.
 */
const processGlobal = globalThis as typeof globalThis & { __timotimePermissionCache?: PermissionCache };
const permissionCache = (processGlobal.__timotimePermissionCache ??= createPermissionCache({
  load: ({ organizationId, accountId }) =>
    getMachineCoreClient().getProductPermissionSnapshot({
      path: { productKey: TIMOTIME_PERMISSIONS.product },
      query: { organizationId, accountId },
    }),
}));

/**
 * Pobiera migawkę uprawnień z pamięci podręcznej (5 min, odświeżana od razu przy wyższym `authz_rev`).
 * `organizationId`, `accountId` i `authzRevision` pochodzą wyłącznie ze zweryfikowanego tokenu/sesji.
 */
export function getPermissionSnapshot(caller: Caller): Promise<PermissionSnapshot> {
  return permissionCache.get({
    organizationId: caller.organizationId,
    accountId: caller.accountId,
    authzRevision: caller.context.authzRevision,
  });
}

/** Czyści pamięć podręczną migawek uprawnień (np. w testach lub po zdarzeniu zmiany uprawnień). */
export function invalidatePermissionCache(filter?: PermissionCacheFilter): void {
  permissionCache.invalidate(filter);
}

function assertProductAccess(snapshot: PermissionSnapshot): void {
  if (!snapshot.products.includes(TIMOTIME_PERMISSIONS.product)) {
    throw new ApiFailure(403, "PRODUCT_ACCESS_REQUIRED", PRODUCT_ACCESS_REQUIRED_MESSAGE);
  }
}

/**
 * Wylicza możliwości widoczne w interfejsie (np. pokazanie zakładki Zespół) na podstawie migawki Core.
 */
export function capabilitiesFromSnapshot(snapshot: PermissionSnapshot): Capabilities {
  return {
    trackOwnTime:
      can(snapshot, TIMOTIME_PERMISSIONS.keys["entries.read_own"]) &&
      can(snapshot, TIMOTIME_PERMISSIONS.keys["entries.write_own"]),
    viewTeam: scopeOf(snapshot, TIMOTIME_PERMISSIONS.keys["entries.read"]).type !== "NONE",
  };
}

/** Zwraca możliwości zalogowanej osoby dla trasy `GET /api/v1/me`. */
export async function getUserCapabilities(caller: Caller): Promise<Capabilities> {
  const snapshot = await getPermissionSnapshot(caller);
  return capabilitiesFromSnapshot(snapshot);
}

/**
 * Jedyny punkt sprawdzania uprawnień po stronie serwera TimoTime (ADR-0036).
 * Sprawdza obecność produktu `timotime` w migawce oraz wskazane uprawnienie bez celu
 * (np. `timotime.entries.read_own` i `timotime.entries.write_own` w dowolnym zakresie).
 */
export async function assertTimePermission(
  caller: Caller,
  permission: TimotimePermissionKey,
): Promise<PermissionSnapshot> {
  const snapshot = await getPermissionSnapshot(caller);
  assertProductAccess(snapshot);
  if (!can(snapshot, permission)) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do tej operacji");
  }
  return snapshot;
}

/**
 * Zwraca efektywny zakres uprawnienia `timotime.entries.read` dla widoku kierownika (`ORGANIZATION` albo `LIMITED`).
 * Brak produktu daje 403 `PRODUCT_ACCESS_REQUIRED`, a zakres `NONE` daje 403 `PERMISSION_DENIED`.
 */
export async function assertTeamReadScope(caller: Caller): Promise<Exclude<AccessScope, { type: "NONE" }>> {
  const snapshot = await getPermissionSnapshot(caller);
  assertProductAccess(snapshot);
  const scope = scopeOf(snapshot, TIMOTIME_PERMISSIONS.keys["entries.read"]);
  if (scope.type === "NONE") {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do podglądu czasu pracy zespołu");
  }
  return scope;
}
