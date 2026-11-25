/**
 * Testy separacji firm na bazie PostgreSQL (ADR-0037) za pomocą `checkTenantIsolation`
 * z `@monorise-team/testing`: firma B nigdy nie odczyta wpisów czasu pracy firmy A
 * ani przez `withUser`, ani przez `withTeamScope`.
 *
 * Wymaga uruchomionej bazy testowej (`pnpm db:up && pnpm db:migrate`, rola `timo_time_app` z RLS).
 */
import { checkTenantIsolation, formatViolations } from "@monorise-team/testing";
import { uuidv7, withTeamScope, withUser, type Actor } from "@timotime/db";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";

afterAll(async () => {
  await getDb().$disconnect();
});

describe("Separacja firm w bazie danych (checkTenantIsolation, ADR-0037)", () => {
  it("withUser: firma B nigdy nie odczytuje wpisów czasu pracy firmy A", async () => {
    const db = getDb();
    const accountsByTenant = new Map<string, { actor: Actor; employeeId: string }>();

    const actorFor = (tenantId: string) => {
      let entry = accountsByTenant.get(tenantId);
      if (!entry) {
        entry = {
          actor: { organizationId: tenantId, accountId: uuidv7() },
          employeeId: uuidv7(),
        };
        accountsByTenant.set(tenantId, entry);
      }
      return entry;
    };

    const result = await checkTenantIsolation({
      seedAsTenant: async (tenantId) => {
        const { actor, employeeId } = actorFor(tenantId);
        await withUser(db, actor, (tx) =>
          tx.timeEntry.create({
            data: {
              id: uuidv7(),
              organizationId: actor.organizationId,
              accountId: actor.accountId,
              employeeId,
              kind: "WORK",
              startedAt: new Date("2026-11-24T08:00:00.000Z"),
              endedAt: new Date("2026-11-24T16:00:00.000Z"),
              note: "Wpis firmy A",
            },
          }),
        );
      },
      readAsTenant: async (tenantId) => {
        const { actor } = actorFor(tenantId);
        return withUser(db, actor, (tx) => tx.timeEntry.findMany());
      },
      cleanup: async ({ tenantAId, tenantBId }) => {
        for (const tenantId of [tenantAId, tenantBId]) {
          const entry = accountsByTenant.get(tenantId);
          if (entry) {
            await withUser(db, entry.actor, (tx) => tx.timeEntry.deleteMany({}));
          }
        }
      },
    });

    expect(result.passed, formatViolations(result.violations)).toBe(true);
  });

  it("withTeamScope (ALL): kierownik firmy B nigdy nie odczytuje wpisów pracowników firmy A", async () => {
    const db = getDb();
    const employeesByTenant = new Map<string, { owner: Actor; manager: Actor; employeeId: string }>();

    const actorsFor = (tenantId: string) => {
      let entry = employeesByTenant.get(tenantId);
      if (!entry) {
        entry = {
          owner: { organizationId: tenantId, accountId: uuidv7() },
          manager: { organizationId: tenantId, accountId: uuidv7() },
          employeeId: uuidv7(),
        };
        employeesByTenant.set(tenantId, entry);
      }
      return entry;
    };

    const result = await checkTenantIsolation({
      seedAsTenant: async (tenantId) => {
        const { owner, employeeId } = actorsFor(tenantId);
        await withUser(db, owner, (tx) =>
          tx.timeEntry.create({
            data: {
              id: uuidv7(),
              organizationId: owner.organizationId,
              accountId: owner.accountId,
              employeeId,
              kind: "REMOTE",
              startedAt: new Date("2026-11-24T09:00:00.000Z"),
              endedAt: null,
              note: "Praca zdalna firmy A",
            },
          }),
        );
      },
      readAsTenant: async (tenantId) => {
        const { manager } = actorsFor(tenantId);
        return withTeamScope(db, manager, { type: "ALL" }, (tx) => tx.timeEntry.findMany());
      },
      cleanup: async ({ tenantAId, tenantBId }) => {
        for (const tenantId of [tenantAId, tenantBId]) {
          const entry = employeesByTenant.get(tenantId);
          if (entry) {
            await withUser(db, entry.owner, (tx) => tx.timeEntry.deleteMany({}));
          }
        }
      },
    });

    expect(result.passed, formatViolations(result.violations)).toBe(true);
  });

  it("withTeamScope (EMPLOYEES): podanie employeeId z firmy A nie ujawnia jej wpisów firmie B", async () => {
    const db = getDb();
    const sharedTargetEmployeeId = uuidv7();
    const seededOwners = new Map<string, Actor>();

    const result = await checkTenantIsolation({
      seedAsTenant: async (tenantId) => {
        const owner: Actor = { organizationId: tenantId, accountId: uuidv7() };
        seededOwners.set(tenantId, owner);
        await withUser(db, owner, (tx) =>
          tx.timeEntry.create({
            data: {
              id: uuidv7(),
              organizationId: owner.organizationId,
              accountId: owner.accountId,
              employeeId: sharedTargetEmployeeId,
              kind: "WORK",
              startedAt: new Date("2026-11-24T08:00:00.000Z"),
              endedAt: new Date("2026-11-24T12:00:00.000Z"),
            },
          }),
        );
      },
      readAsTenant: async (tenantId) => {
        const manager: Actor = { organizationId: tenantId, accountId: uuidv7() };
        return withTeamScope(db, manager, { type: "EMPLOYEES", employeeIds: [sharedTargetEmployeeId] }, (tx) =>
          tx.timeEntry.findMany(),
        );
      },
      cleanup: async ({ tenantAId, tenantBId }) => {
        for (const tenantId of [tenantAId, tenantBId]) {
          const owner = seededOwners.get(tenantId);
          if (owner) {
            await withUser(db, owner, (tx) => tx.timeEntry.deleteMany({}));
          }
        }
      },
    });

    expect(result.passed, formatViolations(result.violations)).toBe(true);
  });
});
