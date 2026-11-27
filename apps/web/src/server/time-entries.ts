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
import { Prisma, uuidv7, withUser, type TimeEntryModel as TimeEntryRow } from "@timotime/db";
import { ApiFailure } from "./api";
import type { Caller } from "./auth";
import { getDb } from "./db";
import { assertTimePermission } from "./permissions";
import { trackOrganizationForReminders } from "./reminder-orgs";

const OPEN_ENTRY_INDEX = "time_entries_one_open_per_account_idx";

export function serializeTimeEntry(row: TimeEntryRow): TimeEntry {
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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Rozpoznaje naruszenie częściowego indeksu unikalnego `time_entries_one_open_per_account_idx`
 * (Prisma `P2002` albo PostgreSQL SQLSTATE `23505`) przy równoczesnych wywołaniach `POST /api/v1/time/start`.
 */
export function isOpenEntryConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    const details = `${error.message} ${safeJson(error.meta)}`;
    return details.includes(OPEN_ENTRY_INDEX) || !details.includes("time_entries_pkey");
  }
  if (typeof error === "object" && error !== null) {
    const record = error as {
      code?: unknown;
      originalCode?: unknown;
      constraint?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const sqlState = record.code === "23505" || record.originalCode === "23505";
    if (sqlState) {
      const constraint = typeof record.constraint === "string" ? record.constraint : "";
      const message = typeof record.message === "string" ? record.message : "";
      return (
        constraint === OPEN_ENTRY_INDEX ||
        message.includes(OPEN_ENTRY_INDEX) ||
        (constraint === "" && !message.includes("time_entries_pkey"))
      );
    }
    if (record.cause !== undefined && record.cause !== error) {
      return isOpenEntryConflict(record.cause);
    }
  }
  return false;
}

/** Otwarty wpis czasu pracy zalogowanej osoby albo `null`. */
export async function getCurrentTimeEntry(caller: Caller): Promise<TimeEntry | null> {
  await assertTimePermission(caller, TIMOTIME_PERMISSIONS.keys["entries.read_own"]);
  const row = await withUser(getDb(), caller, (tx) =>
    tx.timeEntry.findFirst({ where: { endedAt: null }, orderBy: { startedAt: "desc" } }),
  );
  return row ? serializeTimeEntry(row) : null;
}

/**
 * Rozpoczyna nowy wpis czasu pracy. Jeśli osoba ma już otwarty wpis, najpierw go zamyka
 * w tej samej transakcji (np. praca -> przerwa -> praca). Równoczesny start bez otwartego wpisu
 * trafia w indeks `time_entries_one_open_per_account_idx` i kończy się błędem 409 CONFLICT.
 */
export async function startTimeEntry(caller: Caller, input: StartTimeEntryInput): Promise<TimeEntry> {
  await assertTimePermission(caller, TIMOTIME_PERMISSIONS.keys["entries.write_own"]);
  try {
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
    trackOrganizationForReminders(caller.organizationId);
    return serializeTimeEntry(row);
  } catch (error) {
    if (isOpenEntryConflict(error)) {
      throw new ApiFailure(409, "CONFLICT", "Masz już otwarty wpis");
    }
    throw error;
  }
}

/** Zamyka bieżący otwarty wpis czasu pracy; gdy takiego nie ma, zwraca 409 CONFLICT. */
export async function stopTimeEntry(caller: Caller, input: StopTimeEntryInput): Promise<TimeEntry> {
  await assertTimePermission(caller, TIMOTIME_PERMISSIONS.keys["entries.write_own"]);
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
  return serializeTimeEntry(row);
}

/**
 * Zwraca własne wpisy nakładające się na przedział `[from, to]` (domyślnie dzisiaj, maksymalnie 31 dni),
 * w tym wpisy rozpoczęte przed `from` i zakończone po `from` (np. praca nocna) albo nadal otwarte.
 */
export async function listTimeEntries(caller: Caller, query: TimeEntriesQuery): Promise<TimeEntriesList> {
  await assertTimePermission(caller, TIMOTIME_PERMISSIONS.keys["entries.read_own"]);
  const { from, to } = resolveEntriesRange(query);
  const rows = await withUser(getDb(), caller, (tx) =>
    tx.timeEntry.findMany({
      where: {
        startedAt: { lte: to },
        OR: [{ endedAt: null }, { endedAt: { gte: from } }],
      },
      orderBy: { startedAt: "desc" },
    }),
  );
  return {
    entries: rows.map(serializeTimeEntry),
    from: from.toISOString(),
    to: to.toISOString(),
  };
}
