import "server-only";
import type { Session } from "@monorise-team/auth/next";
import { createCoreClient } from "@monorise-team/sdk";
import type { Me } from "@timotime/contracts";
import { ApiFailure } from "./api";
import { requireUser } from "./auth";
import { config } from "./config";

/**
 * Klient Core API po stronie serwera z tokenem zalogowanej osoby (`@monorise-team/sdk`).
 * Działa wyłącznie z sesją BFF przeglądarki, bo tylko ona ma token odświeżania pozwalający pobrać
 * token dla odbiorcy Core API (token bearer z telefonu ma odbiorcę API TimoTime).
 */
export function createUserCoreClient(session: Session) {
  return createCoreClient({
    baseUrl: config.coreApiUrl,
    getAccessToken: () => session.accessToken(config.coreApiUrl),
  });
}

/** Zwraca osobę, pracownika i firmę z MonoriseCore (`GET /core/v1/me`), aby nagłówek pokazał np. „Anna Nowak · Acme”. */
export async function getCurrentProfile(request: Request): Promise<Me> {
  const caller = await requireUser(request);
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
