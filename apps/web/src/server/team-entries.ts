import "server-only";
import type { AccessScope } from "@monorise-team/permissions";
import { paginate } from "@monorise-team/sdk";
import {
  resolveEntriesRange,
  TIMOTIME_PERMISSIONS,
  type TeamCurrentList,
  type TeamEmployee,
  type TeamTimeEntriesList,
  type TeamTimeEntry,
  type TimeEntriesQuery,
} from "@timotime/contracts";
import { withTeamScope, type TeamScope, type TimeEntryModel as TimeEntryRow } from "@timotime/db";
import type { Caller } from "./auth";
import { getMachineCoreClient } from "./core";
import { getDb } from "./db";
import { assertTeamReadScope } from "./permissions";
import { serializeTimeEntry } from "./time-entries";

/** Maksymalna liczba powtarzalnych parametrów `unitId` i `employeeId` w zapytaniach Core Directory. */
const CORE_DIRECTORY_BATCH_SIZE = 100;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

/**
 * Zamienia zakres uprawnienia `timotime.entries.read` z migawki Core na zakres bazy danych (`TeamScope`).
 *
 * - `ORGANIZATION`: wszyscy pracownicy firmy (`{ type: "ALL" }`).
 * - `LIMITED`: pracownicy przypisani do rozwiniętych jednostek `scope.unitIds` (odczyt przez Core Directory
 *   ze śledzeniem wszystkich stron `paginate`). Nadania typu `RESOURCE` (`scope.resourceIds`) są obecnie
 *   pomijane. Zwraca `null`, gdy w zakresie nie ma żadnych pracowników (bez zapytania do bazy).
 */
async function resolveTeamDbScope(
  organizationId: string,
  accessScope: Exclude<AccessScope, { type: "NONE" }>,
): Promise<TeamScope | null> {
  if (accessScope.type === "ORGANIZATION") {
    return { type: "ALL" };
  }

  // Brak jednostek (np. samo nadanie RESOURCE poza zakresem tego etapu): nigdy nie pytaj o wszystkie jednostki firmy.
  if (accessScope.unitIds.length === 0) {
    return null;
  }

  const core = getMachineCoreClient();
  const employeeIds = new Set<string>();
  for (const unitBatch of chunk(accessScope.unitIds, CORE_DIRECTORY_BATCH_SIZE)) {
    for await (const member of paginate(core.listProductDirectoryUnitMembers, {
      path: { productKey: TIMOTIME_PERMISSIONS.product },
      query: { organizationId, unitId: unitBatch, limit: CORE_DIRECTORY_BATCH_SIZE },
    })) {
      employeeIds.add(member.employeeId);
    }
  }

  if (employeeIds.size === 0) {
    return null;
  }

  return { type: "EMPLOYEES", employeeIds: [...employeeIds] };
}

/**
 * Pobiera imiona i nazwiska wyłącznie potrzebnych pracowników z Core Directory (`core:directory.read`),
 * dzieląc zapytania po 100 identyfikatorów i podążając za stronicowaniem kursorowym.
 */
async function loadTeamEmployees(
  organizationId: string,
  employeeIds: readonly string[],
): Promise<Map<string, TeamEmployee>> {
  const uniqueIds = [...new Set(employeeIds)];
  const map = new Map<string, TeamEmployee>();
  if (uniqueIds.length === 0) {
    return map;
  }

  const core = getMachineCoreClient();
  for (const batch of chunk(uniqueIds, CORE_DIRECTORY_BATCH_SIZE)) {
    for await (const employee of paginate(core.listProductDirectoryEmployees, {
      path: { productKey: TIMOTIME_PERMISSIONS.product },
      query: { organizationId, employeeId: batch, limit: CORE_DIRECTORY_BATCH_SIZE },
    })) {
      map.set(employee.id, {
        id: employee.id,
        firstName: employee.firstName,
        lastName: employee.lastName,
      });
    }
  }

  return map;
}

async function enrichTeamEntries(organizationId: string, rows: readonly TimeEntryRow[]): Promise<TeamTimeEntry[]> {
  if (rows.length === 0) {
    return [];
  }
  const employeesById = await loadTeamEmployees(
    organizationId,
    rows.map((row) => row.employeeId),
  );
  return rows.map((row) => ({
    ...serializeTimeEntry(row),
    employee: employeesById.get(row.employeeId) ?? {
      id: row.employeeId,
      firstName: "Nieznany",
      lastName: "pracownik",
    },
  }));
}

/** Otwarte wpisy czasu pracy osób w zakresie uprawnienia `timotime.entries.read` (kto teraz pracuje). */
export async function getTeamCurrentEntries(caller: Caller): Promise<TeamCurrentList> {
  const accessScope = await assertTeamReadScope(caller);
  const dbScope = await resolveTeamDbScope(caller.organizationId, accessScope);
  if (!dbScope) {
    return { entries: [] };
  }

  const rows = await withTeamScope(getDb(), caller, dbScope, (tx) =>
    tx.timeEntry.findMany({
      where: {
        endedAt: null,
        ...(dbScope.type === "EMPLOYEES" ? { employeeId: { in: [...dbScope.employeeIds] } } : {}),
      },
      orderBy: { startedAt: "desc" },
    }),
  );

  return { entries: await enrichTeamEntries(caller.organizationId, rows) };
}

/**
 * Wpisy czasu pracy zespołu nakładające się na przedział `[from, to]` (domyślnie dzisiaj, maks. 31 dni)
 * dla pracowników w zakresie uprawnienia `timotime.entries.read`.
 */
export async function listTeamTimeEntries(caller: Caller, query: TimeEntriesQuery): Promise<TeamTimeEntriesList> {
  const accessScope = await assertTeamReadScope(caller);
  const { from, to } = resolveEntriesRange(query);
  const dbScope = await resolveTeamDbScope(caller.organizationId, accessScope);
  if (!dbScope) {
    return {
      entries: [],
      from: from.toISOString(),
      to: to.toISOString(),
    };
  }

  const rows = await withTeamScope(getDb(), caller, dbScope, (tx) =>
    tx.timeEntry.findMany({
      where: {
        ...(dbScope.type === "EMPLOYEES" ? { employeeId: { in: [...dbScope.employeeIds] } } : {}),
        startedAt: { lte: to },
        OR: [{ endedAt: null }, { endedAt: { gte: from } }],
      },
      orderBy: { startedAt: "desc" },
    }),
  );

  return {
    entries: await enrichTeamEntries(caller.organizationId, rows),
    from: from.toISOString(),
    to: to.toISOString(),
  };
}
