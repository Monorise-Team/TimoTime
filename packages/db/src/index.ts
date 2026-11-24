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
