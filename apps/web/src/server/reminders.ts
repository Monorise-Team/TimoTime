import "server-only";
import { CoreApiError, paginate, type CoreClient } from "@monorise-team/sdk";
import { TIMOTIME_PERMISSIONS } from "@timotime/contracts";
import { withTeamScope, type PrismaClient } from "@timotime/db";
import { config } from "./config";
import { getMachineCoreClient } from "./core";
import { CoreMachineTokenError } from "./core-machine";
import { getDb } from "./db";
import { sendReminderNotification, type SendReminderNotificationOptions } from "./notifications";
import { getTrackedReminderOrganizations } from "./reminder-orgs";
import {
  computeOrganizationQueryWindow,
  evaluateEmployeeReminders,
  isValidIanaTimeZone,
  type LocalDateString,
  type ReminderEmployee,
  type ReminderTimeEntry,
} from "./reminders-rules";

/**
 * Techniczny identyfikator konta przekazywany do `withTeamScope(..., { type: "ALL" })` przy odczycie
 * wpisów firmy przez zadanie w tle. Polityka RLS `team_read_isolation` pozwala na `SELECT` wyłącznie
 * w obrębie wskazanej firmy (`organization_id`), a `owner_isolation` blokuje wszelkie zapisy.
 */
export const REMINDERS_SYSTEM_ACCOUNT_ID = "00000000-0000-0000-0000-000000000000";

/** Czas ważności pamięci podręcznej katalogu organizacji i pracowników w zadaniu przypomnień (4 min). */
export const DEFAULT_DIRECTORY_CACHE_TTL_MS = 4 * 60_000;

/** Zapasowa strefa czasowa firmy, gdyby Core zwrócił niepoprawną strefę IANA. */
export const DEFAULT_FALLBACK_TIME_ZONE = "Europe/Warsaw";

const CORE_DIRECTORY_PAGE_LIMIT = 100;
const ACCEPTED_KEY_TTL_MS = 24 * 60 * 60_000;
const ACCEPTED_TIMER_KEY_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_ACCEPTED_KEYS = 50_000;

/**
 * Punkt rozszerzenia dla nieobecności i urlopów (docelowo integracja z HiraHR).
 * Zwraca mapę `employeeId -> zbiór dat lokalnych YYYY-MM-DD`, w których osoba jest nieobecna.
 */
export interface AbsenceProvider {
  getAbsentDaysForOrganization(params: {
    readonly organizationId: string;
    readonly employeeIds: readonly string[];
    readonly fromDate: LocalDateString;
    readonly toDate: LocalDateString;
  }): Promise<ReadonlyMap<string, ReadonlySet<LocalDateString>>>;
}

const EMPTY_ABSENCES: ReadonlyMap<string, ReadonlySet<LocalDateString>> = new Map();

/** Domyślny dostawca nieobecności (brak danych o urlopach do czasu integracji z HiraHR). */
export const NOOP_ABSENCE_PROVIDER: AbsenceProvider = {
  async getAbsentDaysForOrganization() {
    return EMPTY_ABSENCES;
  },
};

export type RemindersCoreClient = Pick<
  CoreClient,
  "getProductDirectoryOrganization" | "listProductDirectoryEmployees" | "sendNotification"
>;

/** Minimalny interfejs bazy danych potrzebny do wykrywania firm w `auth.sessions`. */
export interface RemindersSessionDiscoveryDb {
  session: {
    findMany(args: {
      distinct: ["organizationId"];
      select: { organizationId: true };
    }): Promise<Array<{ organizationId: string }>>;
  };
}

export type LoadOrganizationEntriesFn = (
  organizationId: string,
  range: { readonly fromUtc: Date; readonly toUtc: Date },
) => Promise<readonly ReminderTimeEntry[]>;

export interface RemindersRunSummary {
  readonly organizationsChecked: number;
  readonly organizationErrors: number;
  readonly employeesChecked: number;
  readonly queued: number;
  readonly skipped: number;
  readonly deduplicated: number;
  readonly failed: number;
}

export interface CreateRemindersRunnerOptions {
  readonly db?: PrismaClient;
  readonly core?: RemindersCoreClient;
  readonly now?: () => Date;
  readonly intervalMs?: number;
  readonly directoryCacheTtlMs?: number;
  readonly notificationTimeoutMs?: number;
  readonly appUrl?: string;
  readonly absenceProvider?: AbsenceProvider;
  /** Jawna lista firm do sprawdzenia (nadpisuje domyślne odkrywanie; przydatne w testach). */
  readonly organizationIds?: readonly string[];
  /** Własna funkcja zwracająca listę firm do sprawdzenia. */
  readonly listOrganizationIds?: () => Promise<readonly string[]>;
  /** Własna funkcja odczytu wpisów `WORK` firmy w przedziale (domyślnie `withTeamScope` na `db`). */
  readonly loadOrganizationEntries?: LoadOrganizationEntriesFn;
  readonly warn?: (message: string) => void;
  readonly onError?: (error: unknown) => void;
}

export interface RemindersRunner {
  runOnce(overrideNow?: Date): Promise<RemindersRunSummary>;
  start(): () => void;
  clearCache(): void;
}

interface CachedDirectoryEntry {
  readonly fetchedAtMs: number;
  readonly active: boolean;
  readonly timeZone: string;
  readonly employees: readonly ReminderEmployee[];
}

function describeJobError(error: unknown): string {
  if (error instanceof CoreApiError) {
    return `CoreApiError (HTTP ${error.status}, ${error.code}, requestId=${error.requestId})`;
  }
  if (error instanceof CoreMachineTokenError) {
    const parts = [error.status !== undefined ? `HTTP ${error.status}` : null, error.code ?? null].filter(Boolean);
    return parts.length > 0 ? `CoreMachineTokenError (${parts.join(", ")})` : "CoreMachineTokenError";
  }
  if (error instanceof Error) {
    return error.name;
  }
  return "UnknownError";
}

/**
 * Zwraca listę firm mających dane w TimoTime bez naruszania RLS:
 * łączy unikalne firmy z `auth.sessions` (tabela bez RLS) z firmami zapamiętanymi w bieżącym procesie
 * (np. aktywność z aplikacji mobilnej albo zdarzenia z Core).
 */
export async function discoverReminderOrganizationIds(db: RemindersSessionDiscoveryDb): Promise<string[]> {
  const sessionOrgs = await db.session.findMany({
    distinct: ["organizationId"],
    select: { organizationId: true },
  });
  const unique = new Set<string>();
  for (const row of sessionOrgs) {
    unique.add(row.organizationId);
  }
  for (const orgId of getTrackedReminderOrganizations()) {
    unique.add(orgId);
  }
  return [...unique].sort();
}

/**
 * Odczytuje wpisy `WORK` firmy nakładające się na okno `[fromUtc, toUtc]` oraz wszystkie nadal
 * otwarte wpisy `WORK` tej firmy przez `withTeamScope(..., { type: "ALL" })` (RLS `team_read_isolation`).
 * Jedno zapytanie na firmę korzystające z istniejących indeksów po `organization_id`.
 */
export async function loadOrganizationTimeEntriesForReminders(
  db: PrismaClient,
  organizationId: string,
  range: { readonly fromUtc: Date; readonly toUtc: Date },
): Promise<ReminderTimeEntry[]> {
  return withTeamScope(db, { organizationId, accountId: REMINDERS_SYSTEM_ACCOUNT_ID }, { type: "ALL" }, (tx) =>
    tx.timeEntry.findMany({
      where: {
        organizationId,
        kind: "WORK",
        startedAt: { lte: range.toUtc },
        OR: [{ endedAt: null }, { endedAt: { gte: range.fromUtc } }],
      },
      select: {
        id: true,
        employeeId: true,
        accountId: true,
        kind: true,
        startedAt: true,
        endedAt: true,
      },
    }),
  );
}

/**
 * Tworzy wykonawcę zadania przypomnień o czasie pracy:
 * - buforuje katalog firmy i pracowników (1 odczyt na firmę w oknie `directoryCacheTtlMs`),
 * - odczytuje wpisy firmy w jednym zapytaniu zakresowym przez RLS,
 * - deduplikuje już przyjęte klucze idempotencji w pamięci procesu i zawsze przekazuje deterministyczny
 *   nagłówek `Idempotency-Key` do Core (odporność na restarty i powtórzenia),
 * - współdzieli uruchomienie w locie (`single-flight`) przy równoczesnych wywołaniach `runOnce()`.
 */
export function createRemindersRunner(options: CreateRemindersRunnerOptions = {}): RemindersRunner {
  const getNow = options.now ?? (() => new Date());
  const directoryCacheTtlMs = options.directoryCacheTtlMs ?? DEFAULT_DIRECTORY_CACHE_TTL_MS;
  const absenceProvider = options.absenceProvider ?? NOOP_ABSENCE_PROVIDER;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const onError =
    options.onError ??
    ((error: unknown) => {
      warn(`[timotime.reminders] Błąd cyklu przypomnień: ${describeJobError(error)}.`);
    });

  const directoryCache = new Map<string, CachedDirectoryEntry>();
  const acceptedKeys = new Map<string, number>(); // idempotencyKey -> expiresAtMs
  let inFlight: Promise<RemindersRunSummary> | null = null;

  function resolveCore(): RemindersCoreClient {
    return options.core ?? getMachineCoreClient();
  }

  function resolveDb(): PrismaClient {
    return options.db ?? getDb();
  }

  async function listOrganizations(): Promise<readonly string[]> {
    if (options.listOrganizationIds) {
      return options.listOrganizationIds();
    }
    if (options.organizationIds) {
      return [...new Set(options.organizationIds)];
    }
    return discoverReminderOrganizationIds(resolveDb());
  }

  async function loadEntries(
    organizationId: string,
    range: { readonly fromUtc: Date; readonly toUtc: Date },
  ): Promise<readonly ReminderTimeEntry[]> {
    if (options.loadOrganizationEntries) {
      return options.loadOrganizationEntries(organizationId, range);
    }
    return loadOrganizationTimeEntriesForReminders(resolveDb(), organizationId, range);
  }

  function pruneAcceptedKeys(nowMs: number): void {
    for (const [key, expiresAtMs] of acceptedKeys) {
      if (expiresAtMs <= nowMs) {
        acceptedKeys.delete(key);
      }
    }
    if (acceptedKeys.size > MAX_ACCEPTED_KEYS) {
      const overflow = acceptedKeys.size - MAX_ACCEPTED_KEYS;
      let removed = 0;
      for (const key of acceptedKeys.keys()) {
        acceptedKeys.delete(key);
        removed += 1;
        if (removed >= overflow) break;
      }
    }
  }

  function isKeyAlreadyAccepted(key: string, nowMs: number): boolean {
    const expiresAtMs = acceptedKeys.get(key);
    if (expiresAtMs === undefined) return false;
    if (expiresAtMs <= nowMs) {
      acceptedKeys.delete(key);
      return false;
    }
    return true;
  }

  function markKeyAccepted(key: string, isTimer: boolean, nowMs: number): void {
    const ttlMs = isTimer ? ACCEPTED_TIMER_KEY_TTL_MS : ACCEPTED_KEY_TTL_MS;
    acceptedKeys.set(key, nowMs + ttlMs);
  }

  async function loadDirectoryCached(
    core: RemindersCoreClient,
    organizationId: string,
    nowMs: number,
  ): Promise<CachedDirectoryEntry | null> {
    const cached = directoryCache.get(organizationId);
    if (cached && nowMs - cached.fetchedAtMs < directoryCacheTtlMs) {
      return cached.active ? cached : null;
    }

    try {
      const org = await core.getProductDirectoryOrganization({
        path: { productKey: TIMOTIME_PERMISSIONS.product },
        query: { organizationId },
      });

      if (org.status !== "ACTIVE") {
        directoryCache.set(organizationId, {
          fetchedAtMs: nowMs,
          active: false,
          timeZone: DEFAULT_FALLBACK_TIME_ZONE,
          employees: [],
        });
        return null;
      }

      let timeZone = org.timeZone;
      if (!isValidIanaTimeZone(timeZone)) {
        warn(`[timotime.reminders] Nieprawidłowa strefa czasowa firmy, użyto domyślnej ${DEFAULT_FALLBACK_TIME_ZONE}.`);
        timeZone = DEFAULT_FALLBACK_TIME_ZONE;
      }

      const employees: ReminderEmployee[] = [];
      for await (const employee of paginate(core.listProductDirectoryEmployees, {
        path: { productKey: TIMOTIME_PERMISSIONS.product },
        query: { organizationId, limit: CORE_DIRECTORY_PAGE_LIMIT },
      })) {
        if (employee.status !== "ACTIVE" || !employee.accountId) {
          continue;
        }
        employees.push({
          id: employee.id,
          accountId: employee.accountId,
          effectiveWorkSchedule: employee.effectiveWorkSchedule,
        });
      }

      const entry: CachedDirectoryEntry = {
        fetchedAtMs: nowMs,
        active: true,
        timeZone,
        employees,
      };
      directoryCache.set(organizationId, entry);
      return entry;
    } catch (error) {
      if (error instanceof CoreApiError && (error.status === 403 || error.status === 404)) {
        warn(`[timotime.reminders] Pominięto firmę bez dostępu lub nieznaną w Core (${describeJobError(error)}).`);
        directoryCache.set(organizationId, {
          fetchedAtMs: nowMs,
          active: false,
          timeZone: DEFAULT_FALLBACK_TIME_ZONE,
          employees: [],
        });
        return null;
      }
      throw error;
    }
  }

  async function execute(now: Date): Promise<RemindersRunSummary> {
    const nowMs = now.getTime();
    pruneAcceptedKeys(nowMs);

    const core = resolveCore();
    const organizationIds = await listOrganizations();
    const notificationOptions: SendReminderNotificationOptions = {
      core,
      ...(options.appUrl !== undefined ? { appUrl: options.appUrl } : {}),
      ...(options.notificationTimeoutMs !== undefined ? { timeoutMs: options.notificationTimeoutMs } : {}),
      warn,
    };

    let organizationsChecked = 0;
    let organizationErrors = 0;
    let employeesChecked = 0;
    let queued = 0;
    let skipped = 0;
    let deduplicated = 0;
    let failed = 0;

    for (const organizationId of organizationIds) {
      try {
        const directory = await loadDirectoryCached(core, organizationId, nowMs);
        if (!directory) {
          continue;
        }

        organizationsChecked += 1;
        if (directory.employees.length === 0) {
          continue;
        }

        const window = computeOrganizationQueryWindow(now, directory.timeZone);
        const [entries, absentDaysByEmployee] = await Promise.all([
          loadEntries(organizationId, { fromUtc: window.fromUtc, toUtc: window.toUtc }),
          absenceProvider.getAbsentDaysForOrganization({
            organizationId,
            employeeIds: directory.employees.map((emp) => emp.id),
            fromDate: window.fromDate,
            toDate: window.toDate,
          }),
        ]);

        const entriesByEmployee = new Map<string, ReminderTimeEntry[]>();
        for (const entry of entries) {
          const list = entriesByEmployee.get(entry.employeeId);
          if (list) {
            list.push(entry);
          } else {
            entriesByEmployee.set(entry.employeeId, [entry]);
          }
        }

        for (const employee of directory.employees) {
          employeesChecked += 1;
          const absentDates = absentDaysByEmployee.get(employee.id);
          const isAbsent =
            absentDates && absentDates.size > 0 ? (date: LocalDateString) => absentDates.has(date) : undefined;
          const candidates = evaluateEmployeeReminders({
            employee,
            entries: entriesByEmployee.get(employee.id) ?? [],
            now,
            timeZone: directory.timeZone,
            ...(isAbsent ? { isAbsent } : {}),
          });

          for (const candidate of candidates) {
            if (isKeyAlreadyAccepted(candidate.idempotencyKey, nowMs)) {
              deduplicated += 1;
              continue;
            }

            const outcome = await sendReminderNotification(
              {
                organizationId,
                recipientAccountId: candidate.recipientAccountId,
                reminderKind: candidate.kind,
                title: candidate.title,
                body: candidate.body,
                actionTarget: candidate.actionTarget,
                idempotencyKey: candidate.idempotencyKey,
              },
              notificationOptions,
            );

            if (outcome === "queued") {
              markKeyAccepted(candidate.idempotencyKey, candidate.kind === "forgotten-timer", nowMs);
              queued += 1;
            } else if (outcome === "skipped") {
              markKeyAccepted(candidate.idempotencyKey, candidate.kind === "forgotten-timer", nowMs);
              skipped += 1;
            } else {
              failed += 1;
            }
          }
        }
      } catch (error) {
        organizationErrors += 1;
        warn(`[timotime.reminders] Błąd przetwarzania przypomnień firmy: ${describeJobError(error)}.`);
      }
    }

    return {
      organizationsChecked,
      organizationErrors,
      employeesChecked,
      queued,
      skipped,
      deduplicated,
      failed,
    };
  }

  function runOnce(overrideNow?: Date): Promise<RemindersRunSummary> {
    if (inFlight) {
      return inFlight;
    }
    const run = (async () => {
      try {
        return await execute(overrideNow ?? getNow());
      } finally {
        inFlight = null;
      }
    })();
    inFlight = run;
    return run;
  }

  function start(): () => void {
    const intervalMs = options.intervalMs ?? config.remindersIntervalMs;
    if (intervalMs <= 0) {
      return () => {};
    }

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scheduleNext = () => {
      if (stopped) return;
      timer = setTimeout(() => {
        timer = undefined;
        void tick();
      }, intervalMs);
      timer.unref?.();
    };

    const tick = async () => {
      if (stopped) return;
      try {
        await runOnce();
      } catch (error) {
        try {
          onError(error);
        } catch {
          // Nie przerywamy pętli zadania przez błąd w callbacku logowania.
        }
      }
      scheduleNext();
    };

    void tick();

    return () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
  }

  function clearCache(): void {
    directoryCache.clear();
    acceptedKeys.clear();
  }

  return { runOnce, start, clearCache };
}

// Strażnik „jedno zadanie przypomnień na proces” we wspólnym obiekcie procesu (Next.js / HMR).
const processGlobal = globalThis as typeof globalThis & { __timotimeStopRemindersPolling?: (() => void) | null };

/**
 * Uruchamia cykliczne zadanie przypomnień o czasie pracy raz na proces, gdy `config.remindersIntervalMs > 0`
 * (domyślnie co 5 minut; `TIMOTIME_REMINDERS_INTERVAL_MS=0` wyłącza). Zwraca funkcję zatrzymującą.
 */
export function startRemindersPolling(options: CreateRemindersRunnerOptions = {}): () => void {
  if (processGlobal.__timotimeStopRemindersPolling) {
    return processGlobal.__timotimeStopRemindersPolling;
  }

  const intervalMs = options.intervalMs ?? config.remindersIntervalMs;
  if (intervalMs <= 0) {
    return () => {};
  }

  const runner = createRemindersRunner({ ...options, intervalMs });
  const stop = runner.start();
  const wrappedStop = () => {
    stop();
    if (processGlobal.__timotimeStopRemindersPolling === wrappedStop) {
      processGlobal.__timotimeStopRemindersPolling = null;
    }
  };
  processGlobal.__timotimeStopRemindersPolling = wrappedStop;
  return wrappedStop;
}
