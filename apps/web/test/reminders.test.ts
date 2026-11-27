/**
 * Testy wysyłki powiadomień (`notifications.ts`), konfiguracji interwału i zadania przypomnień
 * (`reminders.ts`) z atrapą MonoriseCore (`createFakeCore` + adapter katalogu i powiadomień)
 * oraz wpisami w pamięci, bez PostgreSQL.
 */
import { createFakeCore, type FakeCore, type FakeOrganizationBuilder } from "@monorise-team/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config, DEFAULT_REMINDERS_INTERVAL_MS } from "@/server/config";
import { resetMachineCoreTokenCache, setCoreRetryForTests } from "@/server/core";
import {
  CORE_DIRECTORY_READ_SCOPE,
  CORE_EVENTS_READ_SCOPE,
  CORE_NOTIFICATIONS_SEND_SCOPE,
  CORE_PERMISSIONS_READ_SCOPE,
  CORE_PERMISSIONS_REGISTER_SCOPE,
} from "@/server/core-machine";
import {
  buildReminderActionUrl,
  sendReminderNotification,
  TIMOTIME_REMINDERS_NOTIFICATION_CATEGORY,
} from "@/server/notifications";
import { resetTrackedReminderOrganizationsForTests, trackOrganizationForReminders } from "@/server/reminder-orgs";
import {
  createRemindersRunner,
  discoverReminderOrganizationIds,
  startRemindersPolling,
  type AbsenceProvider,
} from "@/server/reminders";
import type { ReminderTimeEntry, WorkSchedule } from "@/server/reminders-rules";
import {
  createFakeCoreRemindersFetch,
  type CapturedNotificationRequest,
  type FakeRemindersOrganizationConfig,
  type NotificationFault,
} from "./helpers/fake-core-reminders";

const FAKE_CORE_URL = "http://core.reminders.test";
const APP_URL = "http://timo-time.localhost:3300";
const CLIENT_ID = "timotime-web";
const CLIENT_SECRET = "sekret-klienta-tylko-do-testow";
const FAST_RETRY = { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 } as const;

const FULL_TIME: WorkSchedule = { 1: 480, 2: 480, 3: 480, 4: 480, 5: 480, 6: 0, 7: 0 };
const MON_WED_4H: WorkSchedule = { 1: 240, 2: 240, 3: 240, 4: 0, 5: 0, 6: 0, 7: 0 };

const originalEnv = { ...process.env };

function makeEntry(params: {
  id: string;
  employeeId: string;
  accountId: string;
  kind?: ReminderTimeEntry["kind"];
  startedAt: string;
  endedAt: string | null;
}): ReminderTimeEntry {
  return {
    id: params.id,
    employeeId: params.employeeId,
    accountId: params.accountId,
    kind: params.kind ?? "WORK",
    startedAt: new Date(params.startedAt),
    endedAt: params.endedAt ? new Date(params.endedAt) : null,
  };
}

describe("buildReminderActionUrl i sendReminderNotification", () => {
  let fakeCore: FakeCore;
  let acme: FakeOrganizationBuilder;
  let capturedRequests: CapturedNotificationRequest[];
  let faultQueue: NotificationFault[];

  beforeAll(async () => {
    fakeCore = await createFakeCore({
      issuer: FAKE_CORE_URL,
      coreApiUrl: FAKE_CORE_URL,
      products: [
        {
          key: "timotime",
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          scopes: [
            CORE_PERMISSIONS_REGISTER_SCOPE,
            CORE_PERMISSIONS_READ_SCOPE,
            CORE_DIRECTORY_READ_SCOPE,
            CORE_EVENTS_READ_SCOPE,
            CORE_NOTIFICATIONS_SEND_SCOPE,
          ],
        },
      ],
    });
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    fakeCore.reset();
    acme = fakeCore.organization({ name: "Acme", domain: "acme.test" });
    acme.grantEntitlement("timotime");
    capturedRequests = [];
    faultQueue = [];

    process.env.CORE_AUTH_URL = FAKE_CORE_URL;
    process.env.CORE_API_URL = FAKE_CORE_URL;
    process.env.TIMOTIME_APP_URL = APP_URL;
    resetMachineCoreTokenCache();
    setCoreRetryForTests(FAST_RETRY);

    vi.spyOn(globalThis, "fetch").mockImplementation(
      createFakeCoreRemindersFetch(fakeCore, {
        expectedActionOrigin: APP_URL,
        onNotificationRequest: (req) => capturedRequests.push(req),
        getNotificationFault: () => faultQueue.shift() ?? null,
      }),
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    setCoreRetryForTests();
    resetMachineCoreTokenCache();
  });

  it("buduje poprawne linki actionUrl na originie aplikacji i odrzuca niepoprawne adresy", () => {
    expect(
      buildReminderActionUrl("https://timo-time.monorise.studio/app", { type: "missing-hours", date: "2026-11-20" }),
    ).toBe("https://timo-time.monorise.studio/?date=2026-11-20#moj-czas");
    expect(
      buildReminderActionUrl(APP_URL, { type: "forgotten-timer", entryId: "019a0000-0000-7000-8000-000000000010" }),
    ).toBe("http://timo-time.localhost:3300/?entry=019a0000-0000-7000-8000-000000000010#moj-czas");
    expect(buildReminderActionUrl(APP_URL, { type: "weekly-summary", isoWeekKey: "2026-W47" })).toBe(
      "http://timo-time.localhost:3300/?view=week&week=2026-W47#moj-czas",
    );

    expect(buildReminderActionUrl("javascript:alert(1)", { type: "missing-hours", date: "2026-11-20" })).toBeNull();
    expect(buildReminderActionUrl("not-a-url", { type: "missing-hours", date: "2026-11-20" })).toBeNull();
    expect(buildReminderActionUrl(APP_URL, { type: "missing-hours", date: "bad" })).toBeNull();
    expect(buildReminderActionUrl(APP_URL, { type: "forgotten-timer", entryId: "   " })).toBeNull();
    expect(buildReminderActionUrl(APP_URL, { type: "weekly-summary", isoWeekKey: "2026-47" })).toBeNull();
  });

  it("ponawia chwilowe 503 tym samym Idempotency-Key i zwraca queued", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["timotime"] });
    const warnings: string[] = [];
    faultQueue.push({ status: 503 });

    const outcome = await sendReminderNotification(
      {
        organizationId: acme.id,
        recipientAccountId: anna.accountId,
        reminderKind: "missing-hours",
        title: "Uzupełnij czas pracy za piątek 20.11",
        body: "W TimoTime nie ma wpisu za piątek 20 listopada, a według Twojego grafiku to dzień pracy.",
        actionTarget: { type: "missing-hours", date: "2026-11-20" },
        idempotencyKey: `timotime-missing:${anna.employeeId}:2026-11-20`,
      },
      { warn: (msg) => warnings.push(msg) },
    );

    expect(outcome).toBe("queued");
    expect(warnings).toEqual([]);
    expect(capturedRequests).toHaveLength(2);
    expect(capturedRequests[0]?.idempotencyKey).toBe(`timotime-missing:${anna.employeeId}:2026-11-20`);
    expect(capturedRequests[1]?.idempotencyKey).toBe(`timotime-missing:${anna.employeeId}:2026-11-20`);
    expect(capturedRequests[1]?.body).toEqual({
      recipientAccountId: anna.accountId,
      category: TIMOTIME_REMINDERS_NOTIFICATION_CATEGORY,
      title: "Uzupełnij czas pracy za piątek 20.11",
      body: "W TimoTime nie ma wpisu za piątek 20 listopada, a według Twojego grafiku to dzień pracy.",
      actionUrl: "http://timo-time.localhost:3300/?date=2026-11-20#moj-czas",
    });
  });

  it("przy 500, błędzie sieci i przekroczeniu limitu czasu nie rzuca wyjątku i nie loguje danych osobowych", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["timotime"] });
    const warnings: string[] = [];
    faultQueue.push({ status: 500 });

    const res500 = await sendReminderNotification(
      {
        organizationId: acme.id,
        recipientAccountId: anna.accountId,
        reminderKind: "forgotten-timer",
        title: "Poufny tytuł dla Anna Nowak",
        body: "Poufna treść dla anna@acme.test",
        actionTarget: { type: "forgotten-timer", entryId: "entry-secret" },
        idempotencyKey: "timotime-timer:entry-secret",
      },
      { warn: (msg) => warnings.push(msg) },
    );

    expect(res500).toBe("failed");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("forgotten-timer");
    expect(warnings[0]).toContain("HTTP 500");
    expect(warnings[0]).not.toContain("Anna");
    expect(warnings[0]).not.toContain("Nowak");
    expect(warnings[0]).not.toContain(anna.accountId);
    expect(warnings[0]).not.toContain(CLIENT_SECRET);
    expect(warnings[0]).not.toContain("Bearer");

    const hangingCore = {
      sendNotification: ({ signal }: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    };

    const resTimeout = await sendReminderNotification(
      {
        organizationId: acme.id,
        recipientAccountId: anna.accountId,
        reminderKind: "weekly-summary",
        title: "Podsumowanie",
        body: "Treść",
        actionTarget: { type: "weekly-summary", isoWeekKey: "2026-W47" },
        idempotencyKey: `timotime-week:${anna.employeeId}:2026-W47`,
      },
      { core: hangingCore, timeoutMs: 25, warn: (msg) => warnings.push(msg) },
    );

    expect(resTimeout).toBe("failed");
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("weekly-summary");
    expect(warnings[1]).not.toContain(anna.accountId);
  });
});

describe("zadanie przypomnień o czasie pracy (createRemindersRunner + atrapa Core)", () => {
  let fakeCore: FakeCore;
  let acme: FakeOrganizationBuilder;
  let organizationsConfig: Map<string, FakeRemindersOrganizationConfig>;
  let employeeSchedules: Map<string, WorkSchedule | null>;
  let disabledPreferences: Set<string>;
  let requested: CapturedNotificationRequest[];
  let queued: CapturedNotificationRequest[];
  let faultQueue: NotificationFault[];
  let counters: {
    directoryOrganization: number;
    directoryEmployees: number;
    notificationsRequested: number;
    notificationsQueued: number;
    notificationsReplayed: number;
  };
  let pageSize: number | undefined;

  beforeAll(async () => {
    fakeCore = await createFakeCore({
      issuer: FAKE_CORE_URL,
      coreApiUrl: FAKE_CORE_URL,
      products: [
        {
          key: "timotime",
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          scopes: [
            CORE_PERMISSIONS_REGISTER_SCOPE,
            CORE_PERMISSIONS_READ_SCOPE,
            CORE_DIRECTORY_READ_SCOPE,
            CORE_EVENTS_READ_SCOPE,
            CORE_NOTIFICATIONS_SEND_SCOPE,
          ],
        },
      ],
    });
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    fakeCore.reset();
    acme = fakeCore.organization({ name: "Acme", domain: "acme.test" });
    acme.grantEntitlement("timotime");

    organizationsConfig = new Map([[acme.id, { timeZone: "Europe/Warsaw", defaultWorkSchedule: null }]]);
    employeeSchedules = new Map();
    disabledPreferences = new Set();
    requested = [];
    queued = [];
    faultQueue = [];
    pageSize = undefined;
    counters = {
      directoryOrganization: 0,
      directoryEmployees: 0,
      notificationsRequested: 0,
      notificationsQueued: 0,
      notificationsReplayed: 0,
    };

    process.env.CORE_AUTH_URL = FAKE_CORE_URL;
    process.env.CORE_API_URL = FAKE_CORE_URL;
    process.env.TIMOTIME_APP_URL = APP_URL;
    resetMachineCoreTokenCache();
    resetTrackedReminderOrganizationsForTests();
    setCoreRetryForTests(FAST_RETRY);

    vi.spyOn(globalThis, "fetch").mockImplementation(
      createFakeCoreRemindersFetch(fakeCore, {
        organizations: organizationsConfig,
        employeeSchedules,
        disabledPreferenceAccountIds: disabledPreferences,
        expectedActionOrigin: APP_URL,
        onNotificationRequest: (req) => requested.push(req),
        onNotificationQueued: (req) => queued.push(req),
        getNotificationFault: () => faultQueue.shift() ?? null,
        getDirectoryPageSize: () => pageSize,
        counters,
      }),
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    setCoreRetryForTests();
    resetMachineCoreTokenCache();
    resetTrackedReminderOrganizationsForTests();
  });

  it("Anna (pełny etat) bez wpisu w piątek dostaje przypomnienie w poniedziałek o 09:00, a nie przed 09:00", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["timotime"] });
    employeeSchedules.set(anna.employeeId, FULL_TIME);

    const runner = createRemindersRunner({
      organizationIds: [acme.id],
      loadOrganizationEntries: async () => [],
    });

    // Poniedziałek 2026-11-23 08:55 CET (07:55Z) -> jeszcze przed 09:00
    const beforeNine = await runner.runOnce(new Date("2026-11-23T07:55:00.000Z"));
    expect(beforeNine.queued).toBe(0);
    expect(queued).toHaveLength(0);

    // Poniedziałek 2026-11-23 09:00 CET (08:00Z) -> wysyła przypomnienie za piątek 20.11
    const atNine = await runner.runOnce(new Date("2026-11-23T08:00:00.000Z"));
    expect(atNine.queued).toBe(1);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      organizationId: acme.id,
      idempotencyKey: `timotime-missing:${anna.employeeId}:2026-11-20`,
      body: {
        recipientAccountId: anna.accountId,
        category: "timotime.reminders",
        title: "Uzupełnij czas pracy za piątek 20.11",
        body: "W TimoTime nie ma wpisu za piątek 20 listopada, a według Twojego grafiku to dzień pracy.",
        actionUrl: "http://timo-time.localhost:3300/?date=2026-11-20#moj-czas",
      },
    });
  });

  it("Jan (pn-śr 4 h) nie dostaje przypomnienia w czwartek, a osoba bez grafiku nie dostaje go nigdy", async () => {
    const jan = acme.addEmployee({ firstName: "Jan", lastName: "Kowalski", products: ["timotime"] });
    employeeSchedules.set(jan.employeeId, MON_WED_4H);

    const noSchedule = acme.addEmployee({ firstName: "Ewa", lastName: "BezGrafiku", products: ["timotime"] });
    employeeSchedules.set(noSchedule.employeeId, null);

    // Pracownik bez konta nie może dostać powiadomienia
    const noAccount = acme.addEmployee({ firstName: "Marek", lastName: "BezKonta", createAccount: false });
    employeeSchedules.set(noAccount.employeeId, FULL_TIME);

    const runner = createRemindersRunner({
      organizationIds: [acme.id],
      loadOrganizationEntries: async () => [],
    });

    // Czwartek 2026-11-19 09:30 CET (08:30Z): Jan nie pracuje w czwartek, Ewa nie ma grafiku
    const result = await runner.runOnce(new Date("2026-11-19T08:30:00.000Z"));
    expect(result.queued).toBe(0);
    expect(result.employeesChecked).toBe(2); // Marek bez konta pominięty
    expect(queued).toHaveLength(0);
  });

  it("stoper rozpoczęty o 08:00 przy grafiku 8 h uruchamia przypomnienie dopiero po 18:00", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["timotime"] });
    employeeSchedules.set(anna.employeeId, FULL_TIME);

    const timerEntryId = "019a0000-0000-7000-8000-000000000501";
    // Wtorek 17.11 (nie ostatni dzień tygodnia); poniedziałek 16.11 ma wpis WORK, żeby nie uruchomić „braku godzin”
    const tuesdayEntries: ReminderTimeEntry[] = [
      makeEntry({
        id: "mon-work",
        employeeId: anna.employeeId,
        accountId: anna.accountId,
        startedAt: "2026-11-16T07:00:00.000Z",
        endedAt: "2026-11-16T15:00:00.000Z",
      }),
      makeEntry({
        id: timerEntryId,
        employeeId: anna.employeeId,
        accountId: anna.accountId,
        startedAt: "2026-11-17T07:00:00.000Z", // 08:00 CET
        endedAt: null,
      }),
    ];

    const runner = createRemindersRunner({
      organizationIds: [acme.id],
      loadOrganizationEntries: async () => tuesdayEntries,
    });

    // 18:00:00 CET (17:00:00Z) = dokładnie 600 min -> jeszcze NIE przekracza progu
    const exactBoundary = await runner.runOnce(new Date("2026-11-17T17:00:00.000Z"));
    expect(exactBoundary.queued).toBe(0);
    expect(queued).toHaveLength(0);

    // 18:05:00 CET (17:05:00Z) = 605 min > 600 min -> przypomnienie!
    const afterTenHours = await runner.runOnce(new Date("2026-11-17T17:05:00.000Z"));
    expect(afterTenHours.queued).toBe(1);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      idempotencyKey: `timotime-timer:${timerEntryId}`,
      body: {
        recipientAccountId: anna.accountId,
        category: "timotime.reminders",
        title: "Sprawdź otwarty wpis czasu pracy",
        actionUrl: `http://timo-time.localhost:3300/?entry=${timerEntryId}#moj-czas`,
      },
    });
    expect(queued[0]?.body.body).toContain("08:00");
    expect(queued[0]?.body.body).toContain("10 godz. 5 min");
  });

  it("wysyła podsumowanie tygodnia w piątek o 15:00 z brakującymi godzinami zaokrąglonymi do 15 min", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["timotime"] });
    employeeSchedules.set(anna.employeeId, FULL_TIME);

    // Pn-czw po 8 h (32 h), w piątek stoper od 08:00 CET trwa do 15:00 CET (7 h) -> razem 39 h z 40 h,
    // a gdy w czwartek było tylko 6 h 20 min -> 37 h 20 min z 40 h (brak 2 h 40 min -> zaokr. 2 godz. 45 min)
    const weekEntries: ReminderTimeEntry[] = [
      makeEntry({
        id: "mon",
        employeeId: anna.employeeId,
        accountId: anna.accountId,
        startedAt: "2026-11-16T07:00:00.000Z",
        endedAt: "2026-11-16T15:00:00.000Z",
      }),
      makeEntry({
        id: "tue",
        employeeId: anna.employeeId,
        accountId: anna.accountId,
        startedAt: "2026-11-17T07:00:00.000Z",
        endedAt: "2026-11-17T15:00:00.000Z",
      }),
      makeEntry({
        id: "wed",
        employeeId: anna.employeeId,
        accountId: anna.accountId,
        startedAt: "2026-11-18T07:00:00.000Z",
        endedAt: "2026-11-18T15:00:00.000Z",
      }),
      makeEntry({
        id: "thu",
        employeeId: anna.employeeId,
        accountId: anna.accountId,
        startedAt: "2026-11-19T07:00:00.000Z",
        endedAt: "2026-11-19T13:20:00.000Z",
      }),
      makeEntry({
        id: "fri-open",
        employeeId: anna.employeeId,
        accountId: anna.accountId,
        startedAt: "2026-11-20T07:00:00.000Z",
        endedAt: null,
      }),
    ];

    const runner = createRemindersRunner({
      organizationIds: [acme.id],
      loadOrganizationEntries: async () => weekEntries,
    });

    // Piątek 2026-11-20 14:55 CET (13:55Z) -> przed 15:00, brak podsumowania
    const beforeThree = await runner.runOnce(new Date("2026-11-20T13:55:00.000Z"));
    expect(beforeThree.queued).toBe(0);

    // Piątek 2026-11-20 15:00 CET (14:00Z) -> 37 h 20 min z 40 h, brak 160 min -> zaokr. 165 min = 2 godz. 45 min
    const atThree = await runner.runOnce(new Date("2026-11-20T14:00:00.000Z"));
    expect(atThree.queued).toBe(1);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      idempotencyKey: `timotime-week:${anna.employeeId}:2026-W47`,
      body: {
        recipientAccountId: anna.accountId,
        category: "timotime.reminders",
        title: "Podsumowanie tygodnia: brakuje 2 godz. 45 min",
        body: "W tym tygodniu zarejestrowano 37 godz. 20 min pracy z planowanych 40 godz. (brakuje około 2 godz. 45 min). Sprawdź swoje wpisy w TimoTime.",
        actionUrl: "http://timo-time.localhost:3300/?view=week&week=2026-W47#moj-czas",
      },
    });
  });

  it("pomija polskie święto 11.11 jako dzień wolny (w dzień święta nic, a w tygodniu ze świętem zmniejsza plan)", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["timotime"] });
    employeeSchedules.set(anna.employeeId, FULL_TIME);

    // Środa 2026-11-11 09:30 CET (08:30Z) — brak wpisów we wtorek, ale środa to święto -> brak przypomnienia
    const holidayRunner = createRemindersRunner({
      organizationIds: [acme.id],
      loadOrganizationEntries: async () => [],
    });
    const onHoliday = await holidayRunner.runOnce(new Date("2026-11-11T08:30:00.000Z"));
    expect(onHoliday.queued).toBe(0);
    expect(queued).toHaveLength(0);

    // Piątek 2026-11-13 15:00 CET (14:00Z): tydzień ze świętem 11.11 ma plan 32 h (4 dni * 8 h).
    // Anna przepracowała pn, wt, czw i pt po 8 h (razem 32 h) -> brak przypomnienia tygodniowego!
    const holidayWeekEntries: ReminderTimeEntry[] = [
      makeEntry({
        id: "d1",
        employeeId: anna.employeeId,
        accountId: anna.accountId,
        startedAt: "2026-11-09T07:00:00.000Z",
        endedAt: "2026-11-09T15:00:00.000Z",
      }),
      makeEntry({
        id: "d2",
        employeeId: anna.employeeId,
        accountId: anna.accountId,
        startedAt: "2026-11-10T07:00:00.000Z",
        endedAt: "2026-11-10T15:00:00.000Z",
      }),
      makeEntry({
        id: "d4",
        employeeId: anna.employeeId,
        accountId: anna.accountId,
        startedAt: "2026-11-12T07:00:00.000Z",
        endedAt: "2026-11-12T15:00:00.000Z",
      }),
      makeEntry({
        id: "d5",
        employeeId: anna.employeeId,
        accountId: anna.accountId,
        startedAt: "2026-11-13T06:00:00.000Z",
        endedAt: "2026-11-13T14:00:00.000Z",
      }),
    ];
    const fridayRunner = createRemindersRunner({
      organizationIds: [acme.id],
      loadOrganizationEntries: async () => holidayWeekEntries,
    });
    const fridayResult = await fridayRunner.runOnce(new Date("2026-11-13T14:00:00.000Z"));
    expect(fridayResult.queued).toBe(0);
    expect(queued).toHaveLength(0);
  });

  it("drugie uruchomienie nic nie wysyła (idempotencja w procesie i po restarcie przez Idempotency-Key)", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["timotime"] });
    employeeSchedules.set(anna.employeeId, FULL_TIME);

    const mondayMorning = new Date("2026-11-23T08:05:00.000Z"); // 09:05 CET
    const runner = createRemindersRunner({
      organizationIds: [acme.id],
      loadOrganizationEntries: async () => [],
    });

    const first = await runner.runOnce(mondayMorning);
    expect(first).toMatchObject({ queued: 1, deduplicated: 0 });
    expect(counters.notificationsRequested).toBe(1);
    expect(counters.notificationsQueued).toBe(1);

    // Drugie uruchomienie tego samego runnera: 0 dodatkowych żądań HTTP do Core
    const second = await runner.runOnce(new Date("2026-11-23T08:10:00.000Z"));
    expect(second).toMatchObject({ queued: 0, deduplicated: 1 });
    expect(counters.notificationsRequested).toBe(1);
    expect(counters.notificationsQueued).toBe(1);

    // Nowy runner (symulacja restartu serwera): wysyła ten sam Idempotency-Key, Core odtwarza odpowiedź bez duplikatu
    const restartedRunner = createRemindersRunner({
      organizationIds: [acme.id],
      loadOrganizationEntries: async () => [],
    });
    await restartedRunner.runOnce(new Date("2026-11-23T08:15:00.000Z"));
    expect(counters.notificationsRequested).toBe(2);
    expect(counters.notificationsReplayed).toBe(1);
    expect(counters.notificationsQueued).toBe(1);
    expect(queued).toHaveLength(1);
  });

  it("ponawia wysyłkę w kolejnym cyklu po chwilowym błędzie 500 oraz buforuje katalog firmy (1 odczyt w oknie TTL)", async () => {
    const anna = acme.addEmployee({
      id: "019a0000-0000-7000-8000-000000000001",
      firstName: "Anna",
      lastName: "Nowak",
      products: ["timotime"],
    });
    const piotr = acme.addEmployee({
      id: "019a0000-0000-7000-8000-000000000002",
      firstName: "Piotr",
      lastName: "Zieliński",
      products: ["timotime"],
    });
    const skippedPref = acme.addEmployee({
      id: "019a0000-0000-7000-8000-000000000003",
      firstName: "Ola",
      lastName: "Wypisana",
      products: ["timotime"],
    });
    organizationsConfig.set(acme.id, { timeZone: "Europe/Warsaw", defaultWorkSchedule: FULL_TIME });
    disabledPreferences.add(skippedPref.accountId);
    pageSize = 2; // wymusza stronicowanie katalogu

    const warnings: string[] = [];
    faultQueue.push({ status: 500 }); // Pierwsza osoba dostaje 500

    const runner = createRemindersRunner({
      organizationIds: [acme.id],
      loadOrganizationEntries: async () => [],
      directoryCacheTtlMs: 4 * 60_000,
      warn: (msg) => warnings.push(msg),
    });

    const t0 = new Date("2026-11-23T08:00:00.000Z");
    const first = await runner.runOnce(t0);
    expect(first).toMatchObject({ organizationsChecked: 1, employeesChecked: 3, failed: 1, queued: 1, skipped: 1 });
    expect(counters.directoryOrganization).toBe(1);
    expect(counters.directoryEmployees).toBe(2); // 3 osoby / pageSize 2 = 2 strony w jednym odczycie
    expect(warnings).toHaveLength(1);

    // 2 minuty później: katalog z pamięci podręcznej (0 nowych wywołań Core Directory), nieudane powiadomienie zostaje ponowione
    const second = await runner.runOnce(new Date(t0.getTime() + 2 * 60_000));
    expect(second).toMatchObject({ failed: 0, queued: 1, deduplicated: 2 });
    expect(counters.directoryOrganization).toBe(1);
    expect(counters.directoryEmployees).toBe(2);
    expect(queued.map((q) => q.body.recipientAccountId).sort()).toEqual([anna.accountId, piotr.accountId].sort());

    // 5 minut później (> 4 min TTL): katalog zostaje odświeżony
    await runner.runOnce(new Date(t0.getTime() + 5 * 60_000));
    expect(counters.directoryOrganization).toBe(2);
  });

  it("wspiera punkt rozszerzenia nieobecności (AbsenceProvider dla przyszłej integracji z HiraHR)", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["timotime"] });
    employeeSchedules.set(anna.employeeId, FULL_TIME);

    // Anna była na urlopie w piątek 20.11, ale pracowała w czwartek 19.11 -> w poniedziałek brak przypomnienia
    const absenceProvider: AbsenceProvider = {
      async getAbsentDaysForOrganization() {
        return new Map([[anna.employeeId, new Set(["2026-11-20"])]]);
      },
    };

    const runner = createRemindersRunner({
      organizationIds: [acme.id],
      absenceProvider,
      loadOrganizationEntries: async () => [
        makeEntry({
          id: "thu-work",
          employeeId: anna.employeeId,
          accountId: anna.accountId,
          startedAt: "2026-11-19T07:00:00.000Z",
          endedAt: "2026-11-19T15:00:00.000Z",
        }),
      ],
    });

    const result = await runner.runOnce(new Date("2026-11-23T08:05:00.000Z"));
    expect(result.queued).toBe(0);
    expect(queued).toHaveLength(0);
  });

  it("odkrywa firmy z auth.sessions oraz rejestru aktywnych firm w procesie", async () => {
    const orgA = "019a0000-0000-7000-8000-00000000000a";
    const orgB = "019a0000-0000-7000-8000-00000000000b";
    trackOrganizationForReminders(orgB);
    trackOrganizationForReminders("nie-uuid");

    const discovered = await discoverReminderOrganizationIds({
      session: {
        async findMany() {
          return [{ organizationId: orgA }, { organizationId: orgB }];
        },
      },
    });
    expect(discovered).toEqual([orgA, orgB]);
  });

  it("konfiguracja TIMOTIME_REMINDERS_INTERVAL_MS ma domyślnie 5 minut, a 0 wyłącza zadanie", async () => {
    delete process.env.TIMOTIME_REMINDERS_INTERVAL_MS;
    expect(config.remindersIntervalMs).toBe(DEFAULT_REMINDERS_INTERVAL_MS);
    expect(DEFAULT_REMINDERS_INTERVAL_MS).toBe(300_000);

    process.env.TIMOTIME_REMINDERS_INTERVAL_MS = "0";
    expect(config.remindersIntervalMs).toBe(0);

    process.env.TIMOTIME_REMINDERS_INTERVAL_MS = "60000";
    expect(config.remindersIntervalMs).toBe(60_000);

    for (const invalid of ["abc", "-500", "1.5", "5m"]) {
      process.env.TIMOTIME_REMINDERS_INTERVAL_MS = invalid;
      expect(config.remindersIntervalMs).toBe(0);
    }

    // startRemindersPolling nic nie robi przy interwale 0 i działa jako singleton przy > 0
    const listOrgs = vi.fn(async () => []);
    process.env.TIMOTIME_REMINDERS_INTERVAL_MS = "0";
    const noopStop = startRemindersPolling({ listOrganizationIds: listOrgs });
    expect(listOrgs).not.toHaveBeenCalled();
    noopStop();

    process.env.TIMOTIME_REMINDERS_INTERVAL_MS = "250";
    const stop1 = startRemindersPolling({ listOrganizationIds: listOrgs });
    const stop2 = startRemindersPolling({ listOrganizationIds: listOrgs });
    expect(stop2).toBe(stop1);
    await vi.waitFor(() => expect(listOrgs).toHaveBeenCalledTimes(1));
    stop1();
  });
});
