import "server-only";
import {
  resolveEntriesRange,
  TIMOTIME_PERMISSIONS,
  type StartTimeEntryInput,
  type StopTimeEntryInput,
  type TimeEntriesList,
  type TimeEntriesQuery,
  type TimeEntry,
} from "@timotime/contracts";
import { uuidv7, withUser, type TimeEntryModel as TimeEntryRow } from "@timotime/db";
import { ApiFailure } from "./api";
import type { Caller } from "./auth";
import { getDb } from "./db";
import { assertTimePermission } from "./permissions";

function serialize(row: TimeEntryRow): TimeEntry {
  return {
    id: row.id,
    organizationId: row.organizationId,
    accountId: row.accountId,
    employeeId: row.employeeId,
    kind: row.kind,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Otwarty wpis czasu pracy zalogowanej osoby albo `null`. */
export async function getCurrentTimeEntry(caller: Caller): Promise<TimeEntry | null> {
  assertTimePermission(caller, TIMOTIME_PERMISSIONS.keys["entries.read_own"]);
  const row = await withUser(getDb(), caller, (tx) =>
    tx.timeEntry.findFirst({ where: { endedAt: null }, orderBy: { startedAt: "desc" } }),
  );
  return row ? serialize(row) : null;
}

/**
 * Rozpoczyna nowy wpis czasu pracy. Jeśli osoba ma już otwarty wpis, najpierw go zamyka
 * w tej samej transakcji (np. praca -> przerwa -> praca).
 */
export async function startTimeEntry(caller: Caller, input: StartTimeEntryInput): Promise<TimeEntry> {
  assertTimePermission(caller, TIMOTIME_PERMISSIONS.keys["entries.write_own"]);
  const row = await withUser(getDb(), caller, async (tx) => {
    const now = new Date();
    const open = await tx.timeEntry.findFirst({ where: { endedAt: null } });
    const boundary = open && open.startedAt > now ? open.startedAt : now;
    if (open) {
      await tx.timeEntry.update({ where: { id: open.id }, data: { endedAt: boundary } });
    }
    return tx.timeEntry.create({
      data: {
        id: uuidv7(boundary.getTime()),
        organizationId: caller.organizationId,
        accountId: caller.accountId,
        employeeId: caller.employeeId,
        kind: input.kind,
        startedAt: boundary,
        endedAt: null,
        note: input.note ?? null,
      },
    });
  });
  return serialize(row);
}

/** Zamyka bieżący otwarty wpis czasu pracy; gdy takiego nie ma, zwraca 409 CONFLICT. */
export async function stopTimeEntry(caller: Caller, input: StopTimeEntryInput): Promise<TimeEntry> {
  assertTimePermission(caller, TIMOTIME_PERMISSIONS.keys["entries.write_own"]);
  const row = await withUser(getDb(), caller, async (tx) => {
    const open = await tx.timeEntry.findFirst({ where: { endedAt: null } });
    if (!open) {
      throw new ApiFailure(409, "CONFLICT", "Brak otwartego wpisu czasu pracy");
    }
    const now = new Date();
    const endedAt = open.startedAt > now ? open.startedAt : now;
    return tx.timeEntry.update({
      where: { id: open.id },
      data: {
        endedAt,
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
    });
  });
  return serialize(row);
}

/** Zwraca własne wpisy w zadanym przedziale czasu (domyślnie dzisiaj, maksymalnie 31 dni). */
export async function listTimeEntries(caller: Caller, query: TimeEntriesQuery): Promise<TimeEntriesList> {
  assertTimePermission(caller, TIMOTIME_PERMISSIONS.keys["entries.read_own"]);
  const { from, to } = resolveEntriesRange(query);
  const rows = await withUser(getDb(), caller, (tx) =>
    tx.timeEntry.findMany({
      where: { startedAt: { gte: from, lte: to } },
      orderBy: { startedAt: "desc" },
    }),
  );
  return {
    entries: rows.map(serialize),
    from: from.toISOString(),
    to: to.toISOString(),
  };
}
