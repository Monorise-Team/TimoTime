import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "./generated/prisma/client.js";

export * from "./generated/prisma/enums.js";
export { Prisma, PrismaClient } from "./generated/prisma/client.js";
export type * from "./generated/prisma/models.js";
export { uuidv7 } from "./ids.js";

/** Klient transakcji: to samo API co PrismaClient, bez metod sterujących połączeniem. */
export type Tx = Prisma.TransactionClient;

/**
 * Klient bazy timo_time. Serwer łączy się rolą timo_time_app (bez uprawnień właściciela tabel i bez
 * BYPASSRLS), więc wpisy czasu pracy są dostępne tylko przez withUser (ADR-0037).
 */
export function createDb(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/** Kto działa: konto Monorise i jego firma, zawsze z tokenu albo sesji Core, nigdy z treści żądania. */
export interface Actor {
  organizationId: string;
  accountId: string;
}

/**
 * Działanie w imieniu osoby z firmy. Ustawia zmienne transakcji `app.organization_id` i `app.account_id`,
 * z których korzystają polityki RLS; po transakcji wartości znikają, więc nie przeciekają między
 * połączeniami z puli.
 */
export async function withUser<T>(db: PrismaClient, actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.organization_id', ${actor.organizationId}, true),
                                set_config('app.account_id', ${actor.accountId}, true)`;
    return fn(tx);
  });
}

/** Zakres odczytu wpisów zespołu przekazywany do polityki RLS `team_read_isolation`. */
export type TeamScope =
  { readonly type: "ALL" } | { readonly type: "EMPLOYEES"; readonly employeeIds: readonly string[] };

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): string {
  if (!UUID_REGEX.test(value)) {
    throw new Error(`Nieprawidłowy UUID w ${label}`);
  }
  return value;
}

/**
 * Działanie w imieniu osoby z uprawnieniem podglądu czasu pracy zespołu (`timotime.entries.read`).
 * Ustawia lokalne zmienne transakcji (`set_config(..., true)`): `app.organization_id`, `app.account_id`
 * oraz zakres zespołu (`app.team_scope = 'ALL'` albo `app.team_employee_ids`). Polityka RLS pozwala
 * wtedy odczytywać wpisy wskazanych pracowników tej samej firmy; zapisy nadal są ograniczone do
 * własnych wierszy właściciela (`owner_isolation`). Wartości pochodzą wyłącznie z danych po stronie serwera.
 */
export async function withTeamScope<T>(
  db: PrismaClient,
  actor: Actor,
  scope: TeamScope,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const organizationId = assertUuid(actor.organizationId, "actor.organizationId");
  const accountId = assertUuid(actor.accountId, "actor.accountId");
  const teamScope = scope.type === "ALL" ? "ALL" : "";
  const employeeIds =
    scope.type === "EMPLOYEES"
      ? [...new Set(scope.employeeIds.map((id) => assertUuid(id, "scope.employeeIds")))].join(",")
      : "";

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.organization_id', ${organizationId}, true),
                                set_config('app.account_id', ${accountId}, true),
                                set_config('app.team_scope', ${teamScope}, true),
                                set_config('app.team_employee_ids', ${employeeIds}, true)`;
    return fn(tx);
  });
}
