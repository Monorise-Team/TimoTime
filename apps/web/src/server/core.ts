import "server-only";
import type { Session } from "@monorise-team/auth/next";
import { createCoreClient, type CoreClient, type CoreRetryConfig, type CoreRetryOption } from "@monorise-team/sdk";
import type { Me } from "@timotime/contracts";
import { ApiFailure } from "./api";
import type { Caller } from "./auth";
import { config } from "./config";
import { CORE_MACHINE_SCOPES, createMachineTokenProvider } from "./core-machine";

const machineTokenProvider = createMachineTokenProvider({
  getConfig: () => ({
    coreAuthUrl: config.coreAuthUrl,
    coreApiUrl: config.coreApiUrl,
    clientId: config.oauthClientId,
    clientSecret: config.oauthClientSecret,
  }),
  scope: CORE_MACHINE_SCOPES,
});

/**
 * Domyślna polityka ponawiania żądań do Core API przy chwilowych błędach sieci, 429 oraz 502/503/504.
 * Pozwala przetrwać krótkie niedostępności MonoriseCore bez przerywania żądania użytkownika.
 */
export const DEFAULT_CORE_RETRY = {
  attempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 2000,
} as const satisfies CoreRetryConfig;

let coreRetryOption: CoreRetryOption = DEFAULT_CORE_RETRY;

/** Nadpisuje politykę ponawiania żądań do Core API (używane w testach; bez argumentu przywraca domyślną). */
export function setCoreRetryForTests(retry: CoreRetryOption = DEFAULT_CORE_RETRY): void {
  coreRetryOption = retry;
}

/**
 * Klient Core API po stronie serwera z tokenem zalogowanej osoby (`@monorise-team/sdk`).
 * Działa wyłącznie z sesją BFF przeglądarki, bo tylko ona ma token odświeżania pozwalający pobrać
 * token dla odbiorcy Core API (token bearer z telefonu ma odbiorcę API TimoTime).
 */
export function createUserCoreClient(session: Session): CoreClient {
  return createCoreClient({
    baseUrl: config.coreApiUrl,
    getAccessToken: () => session.accessToken(config.coreApiUrl),
    retry: coreRetryOption,
  });
}

/**
 * Klient Core API po stronie serwera z tokenem maszynowym produktu (`timotime-web`,
 * zakresy `core:permissions.read core:directory.read core:events.read core:notifications.send`).
 * Służy do pobierania migawki uprawnień, katalogu firm, jednostek i pracowników, kanału zdarzeń
 * oraz zlecania powiadomień e-mail przez `@monorise-team/sdk`.
 */
export function getMachineCoreClient(): CoreClient {
  return createCoreClient({
    baseUrl: config.coreApiUrl,
    getAccessToken: () => machineTokenProvider.getAccessToken(),
    retry: coreRetryOption,
  });
}

/** Czyści pamięć podręczną tokenu maszynowego (używane głównie w testach). */
export function resetMachineCoreTokenCache(): void {
  machineTokenProvider.clear();
}

/**
 * Zwraca osobę, pracownika i firmę z MonoriseCore (`GET /core/v1/me`), aby nagłówek pokazał np. „Anna Nowak · Acme”.
 * Pola `capabilities` dokłada trasa `/api/v1/me` na podstawie migawki uprawnień z Core.
 */
export async function getCurrentProfile(caller: Caller): Promise<Omit<Me, "capabilities">> {
  if (!caller.session) {
    throw new ApiFailure(
      403,
      "PERMISSION_DENIED",
      "Aplikacja na telefon pobiera dane osoby i firmy bezpośrednio z Core API",
    );
  }
  const core = createUserCoreClient(caller.session);
  const me = await core.getMe();
  const fullName = `${me.employee.firstName} ${me.employee.lastName}`.trim();
  return {
    account: {
      id: me.account.id,
      email: me.account.email,
    },
    employee: {
      id: me.employee.id,
      firstName: me.employee.firstName,
      lastName: me.employee.lastName,
      fullName: fullName || me.account.email,
      jobTitle: me.employee.jobTitle,
    },
    organization: {
      id: me.organization.id,
      name: me.organization.name,
    },
  };
}
