import "server-only";
import { createCoreClient } from "@monorise-team/sdk";
import type { Me } from "@timotime/contracts";
import { requireUser, type Caller } from "./auth";
import { config } from "./config";

/**
 * Klient Core API po stronie serwera z tokenem zalogowanej osoby (`@monorise-team/sdk`).
 * W przeglądarce (BFF) pobiera token dla Core API z sesji; przy wywołaniu bearer używa przekazanego tokenu.
 */
export function createUserCoreClient(caller: Caller) {
  return createCoreClient({
    baseUrl: config.coreApiUrl,
    getAccessToken: () => (caller.session ? caller.session.accessToken(config.coreApiUrl) : caller.token),
  });
}

/** Zwraca osobę, pracownika i firmę z MonoriseCore (`GET /core/v1/me`), aby nagłówek pokazał np. „Anna Nowak · Acme”. */
export async function getCurrentProfile(request: Request): Promise<Me> {
  const caller = await requireUser(request);
  const core = createUserCoreClient(caller);
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
