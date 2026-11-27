import { jwtVerify } from "jose";
import type { FakeCore } from "@monorise-team/testing";
import type { WorkSchedule } from "@/server/reminders-rules";

export interface CapturedNotificationRequest {
  readonly organizationId: string;
  readonly idempotencyKey: string | null;
  readonly authorization: string | null;
  readonly body: {
    readonly recipientAccountId: string;
    readonly category: string;
    readonly title: string;
    readonly body: string;
    readonly actionUrl?: string | null;
  };
}

export type NotificationFault = { readonly status: number } | { readonly networkError: true };

export interface FakeRemindersOrganizationConfig {
  readonly timeZone: string;
  readonly defaultWorkSchedule: WorkSchedule | null;
}

export interface FakeCoreRemindersAdapterOptions {
  /** Strefa czasowa i domyślny harmonogram pracy firm (organizationId -> ustawienia). */
  readonly organizations?: ReadonlyMap<string, FakeRemindersOrganizationConfig>;
  /** Indywidualne harmonogramy pracy pracowników (employeeId -> harmonogram). */
  readonly employeeSchedules?: ReadonlyMap<string, WorkSchedule | null>;
  /** Konta z wyłączoną kategorią `timotime.reminders` (zwrócą 202 SKIPPED / PREFERENCE_OFF). */
  readonly disabledPreferenceAccountIds?: ReadonlySet<string>;
  /** Oczekiwany origin `actionUrl` klienta OAuth `timotime-web` (domyślnie `http://timo-time.localhost:3300`). */
  readonly expectedActionOrigin?: string;
  /** Zlicza i przechwytuje każde wywołanie HTTP `POST /core/v1/organizations/{id}/notifications`. */
  readonly onNotificationRequest?: (captured: CapturedNotificationRequest) => void;
  /** Wywoływane tylko dla faktycznie zakolejkowanych powiadomień (bez powtórzeń z tym samym Idempotency-Key). */
  readonly onNotificationQueued?: (captured: CapturedNotificationRequest) => void;
  /** Wstrzykuje błąd dla kolejnego żądania `POST .../notifications`. */
  readonly getNotificationFault?: () => NotificationFault | null;
  /** Opcjonalny rozmiar strony dla `directory/employees`. */
  readonly getDirectoryPageSize?: () => number | undefined;
  /** Zlicza wywołania `directory/organization` i `directory/employees`. */
  readonly counters?: {
    directoryOrganization: number;
    directoryEmployees: number;
    notificationsRequested: number;
    notificationsQueued: number;
    notificationsReplayed: number;
  };
}

const DIR_ORG_PATH = "/core/v1/products/timotime/directory/organization";
const DIR_EMPLOYEES_PATH = "/core/v1/products/timotime/directory/employees";
const NOTIFICATIONS_PATH_REGEX = /^\/core\/v1\/organizations\/([^/]+)\/notifications$/;

function jsonError(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({
      data: null,
      meta: { requestId: `req_fake_${status}` },
      error: { code, message, details: [] },
    }),
    { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
  );
}

/**
 * Adapter `fetch` nad `createFakeCore` do testów zadania przypomnień (wzorowany na KivoTasks):
 * - obsługuje `GET /core/v1/products/timotime/directory/organization` (z `timeZone` i `defaultWorkSchedule`),
 * - rozszerza `GET /core/v1/products/timotime/directory/employees` o `workSchedule` i `effectiveWorkSchedule`,
 * - obsługuje `POST /core/v1/organizations/{organizationId}/notifications` z weryfikacją EdDSA i zakresu
 *   `core:notifications.send`, originu `actionUrl`, dostępu odbiorcy, preferencji oraz deduplikacją `Idempotency-Key`.
 */
export function createFakeCoreRemindersFetch(
  fakeCore: FakeCore,
  options: FakeCoreRemindersAdapterOptions = {},
): typeof fetch {
  const idempotencyStore = new Map<string, { rawBody: string; responseBody: string }>();

  async function verifyMachineToken(request: Request, requiredScope: string): Promise<Response | null> {
    const auth = request.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
      return jsonError(401, "UNAUTHENTICATED", "Brak tokenu dostępu");
    }
    const token = auth.slice(7).trim();
    let scopes: string[];
    try {
      const { payload } = await jwtVerify(token, fakeCore.issuer.localJWKSet, {
        issuer: fakeCore.issuerUrl,
        audience: fakeCore.coreApiUrl,
        algorithms: ["EdDSA"],
      });
      scopes = String(payload.scope ?? "")
        .split(/\s+/)
        .filter(Boolean);
    } catch {
      return jsonError(401, "UNAUTHENTICATED", "Token jest nieważny albo wygasł");
    }
    if (!scopes.includes(requiredScope)) {
      return jsonError(403, "PERMISSION_DENIED", `Brak zakresu ${requiredScope}`);
    }
    return null;
  }

  function hasActiveTimotimeEntitlement(orgId: string): boolean {
    const org = fakeCore.getOrganization(orgId);
    if (!org) return false;
    for (const ent of org.data.entitlements.values()) {
      if (ent.productKey === "timotime" && ent.status === "ACTIVE") {
        return true;
      }
    }
    return false;
  }

  function hasTimotimeAccess(orgId: string, accountId: string): boolean {
    const org = fakeCore.getOrganization(orgId);
    if (!org) return false;
    const account = org.data.accounts.get(accountId);
    if (!account || account.status !== "ACTIVE") return false;
    const employee = org.data.employees.get(account.employeeId);
    if (!employee || employee.status !== "ACTIVE") return false;
    if (org.data.ownerAccountId === accountId) return true;
    for (const access of org.data.appAccesses.values()) {
      if (access.accountId === accountId && access.productKey === "timotime" && access.status === "ACTIVE") {
        return true;
      }
    }
    return false;
  }

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? (init ? new Request(input, init) : input) : new Request(input, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "GET" && url.pathname === DIR_ORG_PATH) {
      if (options.counters) options.counters.directoryOrganization += 1;
      const authError = await verifyMachineToken(request, "core:directory.read");
      if (authError) return authError;

      const orgId = url.searchParams.get("organizationId") ?? "";
      const org = fakeCore.getOrganization(orgId);
      if (!org) {
        return jsonError(404, "NOT_FOUND", "Nie znaleziono firmy");
      }
      if (!hasActiveTimotimeEntitlement(orgId)) {
        return jsonError(403, "PERMISSION_DENIED", "Firma nie ma aktywnego dostępu do produktu");
      }

      const orgCfg = options.organizations?.get(orgId);
      return new Response(
        JSON.stringify({
          data: {
            id: org.id,
            name: org.name,
            status: org.data.status,
            timeZone: orgCfg?.timeZone ?? "Europe/Warsaw",
            defaultWorkSchedule: orgCfg?.defaultWorkSchedule ?? null,
          },
          meta: { requestId: "req_dir_org_ok" },
          error: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      );
    }

    if (method === "GET" && url.pathname === DIR_EMPLOYEES_PATH) {
      if (options.counters) options.counters.directoryEmployees += 1;
      const authError = await verifyMachineToken(request, "core:directory.read");
      if (authError) return authError;

      const orgId = url.searchParams.get("organizationId") ?? "";
      const org = fakeCore.getOrganization(orgId);
      if (!org) {
        return jsonError(404, "NOT_FOUND", "Nie znaleziono firmy");
      }
      if (!hasActiveTimotimeEntitlement(orgId)) {
        return jsonError(403, "PERMISSION_DENIED", "Firma nie ma aktywnego dostępu do produktu");
      }

      const orgCfg = options.organizations?.get(orgId);
      const filterIds = url.searchParams.getAll("employeeId");
      const filterSet = filterIds.length > 0 ? new Set(filterIds) : null;
      const rawLimit = Number(url.searchParams.get("limit") ?? "50");
      const customPageSize = options.getDirectoryPageSize?.();
      const limit = customPageSize !== undefined ? Math.min(rawLimit, customPageSize) : rawLimit;
      const cursorRaw = url.searchParams.get("cursor");
      const afterId = cursorRaw ? Buffer.from(cursorRaw, "base64url").toString("utf8") : undefined;

      const matching = [...org.data.employees.values()]
        .filter((emp) => (filterSet ? filterSet.has(emp.id) : true))
        .filter((emp) => (afterId !== undefined ? emp.id > afterId : true))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      const hasMore = matching.length > limit;
      const items = (hasMore ? matching.slice(0, limit) : matching).map((emp) => {
        const hasOverride = options.employeeSchedules?.has(emp.id) ?? false;
        const workSchedule = hasOverride ? (options.employeeSchedules?.get(emp.id) ?? null) : null;
        const effectiveWorkSchedule = workSchedule ?? orgCfg?.defaultWorkSchedule ?? null;
        return {
          id: emp.id,
          accountId: emp.accountId,
          firstName: emp.firstName,
          lastName: emp.lastName,
          status: emp.status,
          workSchedule,
          effectiveWorkSchedule,
        };
      });
      const last = items[items.length - 1];
      const nextCursor = hasMore && last ? Buffer.from(last.id, "utf8").toString("base64url") : null;

      return new Response(
        JSON.stringify({
          data: items,
          meta: { requestId: "req_dir_emp_ok", nextCursor },
          error: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      );
    }

    const notificationsMatch = method === "POST" ? NOTIFICATIONS_PATH_REGEX.exec(url.pathname) : null;
    if (notificationsMatch) {
      const organizationId = decodeURIComponent(notificationsMatch[1]!);
      const rawBody = await request.text();
      const parsedBody = JSON.parse(rawBody) as CapturedNotificationRequest["body"];
      const authorization = request.headers.get("authorization");
      const idempotencyKey = request.headers.get("idempotency-key");
      const captured: CapturedNotificationRequest = {
        organizationId,
        idempotencyKey,
        authorization,
        body: parsedBody,
      };

      if (options.counters) options.counters.notificationsRequested += 1;
      options.onNotificationRequest?.(captured);

      const fault = options.getNotificationFault?.() ?? null;
      if (fault) {
        if ("networkError" in fault) {
          throw new TypeError("connect ECONNREFUSED");
        }
        return jsonError(fault.status, "INTERNAL_ERROR", "Core notifications fault");
      }

      const authError = await verifyMachineToken(request, "core:notifications.send");
      if (authError) return authError;

      if (!fakeCore.getOrganization(organizationId)) {
        return jsonError(404, "NOT_FOUND", "Nie znaleziono firmy");
      }
      if (!hasActiveTimotimeEntitlement(organizationId)) {
        return jsonError(403, "PERMISSION_DENIED", "Firma nie ma aktywnego dostępu do produktu");
      }

      if (parsedBody.category !== "timotime.reminders") {
        return jsonError(403, "PERMISSION_DENIED", "Nieobsługiwana kategoria powiadomienia");
      }

      if (parsedBody.actionUrl) {
        const expectedOrigin = options.expectedActionOrigin ?? "http://timo-time.localhost:3300";
        let actualOrigin: string;
        try {
          actualOrigin = new URL(parsedBody.actionUrl).origin;
        } catch {
          return jsonError(422, "VALIDATION_FAILED", "Nieprawidłowy actionUrl");
        }
        if (actualOrigin !== expectedOrigin) {
          return jsonError(422, "VALIDATION_FAILED", "Origin actionUrl nie pasuje do klienta OAuth");
        }
      }

      const storeKey = idempotencyKey ? `${organizationId}\0${idempotencyKey}` : null;
      if (storeKey && idempotencyStore.has(storeKey)) {
        const existing = idempotencyStore.get(storeKey)!;
        if (existing.rawBody !== rawBody) {
          return jsonError(409, "CONFLICT", "Klucz Idempotency-Key został użyty z inną treścią");
        }
        if (options.counters) options.counters.notificationsReplayed += 1;
        return new Response(existing.responseBody, {
          status: 202,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Idempotency-Replayed": "true",
          },
        });
      }

      let status: "QUEUED" | "SKIPPED" = "QUEUED";
      let skipReason: "NO_ACCESS" | "PREFERENCE_OFF" | null = null;

      if (!hasTimotimeAccess(organizationId, parsedBody.recipientAccountId)) {
        status = "SKIPPED";
        skipReason = "NO_ACCESS";
      } else if (options.disabledPreferenceAccountIds?.has(parsedBody.recipientAccountId)) {
        status = "SKIPPED";
        skipReason = "PREFERENCE_OFF";
      }

      const responseBody = JSON.stringify({
        data: {
          id: crypto.randomUUID(),
          status,
          skipReason,
        },
        meta: { requestId: "req_notif_ok" },
        error: null,
      });

      if (storeKey) {
        idempotencyStore.set(storeKey, { rawBody, responseBody });
      }
      if (status === "QUEUED") {
        if (options.counters) options.counters.notificationsQueued += 1;
        options.onNotificationQueued?.(captured);
      }

      return new Response(responseBody, {
        status: 202,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    return fakeCore.fetch(input, init);
  }) as typeof fetch;
}
