/**
 * Testy integracyjne zadania przypomnień o czasie pracy na prawdziwej bazie PostgreSQL z RLS
 * (`withUser` do zasiewu wpisów, `withTeamScope` do odczytu w zadaniu, `auth.sessions` do wykrywania firm)
 * oraz z atrapą MonoriseCore (`createFakeCore` + adapter katalogu i powiadomień).
 *
 * Wymaga uruchomionej bazy testowej (`pnpm db:up && pnpm db:migrate`, rola `timo_time_app` z RLS).
 */
import { createFakeCore, type FakeCore, type FakeOrganizationBuilder } from "@monorise-team/testing";
import { uuidv7, withUser, type Actor } from "@timotime/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMachineCoreTokenCache, setCoreRetryForTests } from "@/server/core";
import {
  CORE_DIRECTORY_READ_SCOPE,
  CORE_EVENTS_READ_SCOPE,
  CORE_NOTIFICATIONS_SEND_SCOPE,
  CORE_PERMISSIONS_READ_SCOPE,
  CORE_PERMISSIONS_REGISTER_SCOPE,
} from "@/server/core-machine";
import { getDb } from "@/server/db";
import { resetTrackedReminderOrganizationsForTests } from "@/server/reminder-orgs";
import { createRemindersRunner } from "@/server/reminders";
import type { WorkSchedule } from "@/server/reminders-rules";
import {
  createFakeCoreRemindersFetch,
  type CapturedNotificationRequest,
  type FakeRemindersOrganizationConfig,
} from "./helpers/fake-core-reminders";

const FAKE_CORE_URL = "http://core.reminders-db.test";
const APP_URL = "http://timo-time.localhost:3300";
const CLIENT_ID = "timotime-web";
const CLIENT_SECRET = "sekret-klienta-tylko-do-testow";
const FAST_RETRY = { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 } as const;

const FULL_TIME: WorkSchedule = { 1: 480, 2: 480, 3: 480, 4: 480, 5: 480, 6: 0, 7: 0 };
const MON_WED_4H: WorkSchedule = { 1: 240, 2: 240, 3: 240, 4: 0, 5: 0, 6: 0, 7: 0 };

const originalEnv = { ...process.env };

let fakeCore: FakeCore;
let acme: FakeOrganizationBuilder;
let organizationsConfig: Map<string, FakeRemindersOrganizationConfig>;
let employeeSchedules: Map<string, WorkSchedule | null>;
let queued: CapturedNotificationRequest[];
let counters: {
  directoryOrganization: number;
  directoryEmployees: number;
  notificationsRequested: number;
  notificationsQueued: number;
  notificationsReplayed: number;
};

const seededActors: Actor[] = [];
const seededSessionIds: string[] = [];

async function seedEntry(params: {
  organizationId: string;
  accountId: string;
  employeeId: string;
  kind?: "WORK" | "BREAK" | "REMOTE" | "BUSINESS_TRIP";
  startedAt: string;
  endedAt: string | null;
}): Promise<string> {
  const actor: Actor = { organizationId: params.organizationId, accountId: params.accountId };
  seededActors.push(actor);
  const id = uuidv7(Date.parse(params.startedAt));
  await withUser(getDb(), actor, (tx) =>
    tx.timeEntry.create({
      data: {
        id,
        organizationId: params.organizationId,
        accountId: params.accountId,
        employeeId: params.employeeId,
        kind: params.kind ?? "WORK",
        startedAt: new Date(params.startedAt),
        endedAt: params.endedAt ? new Date(params.endedAt) : null,
      },
    }),
  );
  return id;
}

async function seedSession(organizationId: string, accountId: string): Promise<string> {
  const id = `reminders-test-session-${uuidv7()}`;
  seededSessionIds.push(id);
  await getDb().session.create({
    data: {
      id,
      organizationId,
      accountId,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      data: "encrypted-placeholder",
    },
  });
  return id;
}

async function cleanupSeededData(): Promise<void> {
  const db = getDb();
  const seenActors = new Set<string>();
  for (const actor of seededActors.splice(0)) {
    const key = `${actor.organizationId}:${actor.accountId}`;
    if (seenActors.has(key)) continue;
    seenActors.add(key);
    await withUser(db, actor, (tx) => tx.timeEntry.deleteMany({}));
  }
  const sessionIds = seededSessionIds.splice(0);
  if (sessionIds.length > 0) {
    await db.session.deleteMany({ where: { id: { in: sessionIds } } });
  }
}

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
  queued = [];
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
      expectedActionOrigin: APP_URL,
      onNotificationQueued: (req) => queued.push(req),
      counters,
    }),
  );
});

afterEach(async () => {
  await cleanupSeededData();
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  setCoreRetryForTests();
  resetMachineCoreTokenCache();
  resetTrackedReminderOrganizationsForTests();
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("zadanie przypomnień o czasie pracy z bazą PostgreSQL (RLS)", () => {
  it("Anna (pełny etat) bez wpisu w piątek dostaje przypomnienie w poniedziałek o 09:00, a z wpisem w piątek nic", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["timotime"] });
    const piotr = acme.addEmployee({ firstName: "Piotr", lastName: "Zieliński", products: ["timotime"] });
    employeeSchedules.set(anna.employeeId, FULL_TIME);
    employeeSchedules.set(piotr.employeeId, FULL_TIME);

    // Piotr ma wpis WORK w piątek 20.11, Anna nie ma wpisu WORK (ma jedynie przerwę BREAK)
    await seedEntry({
      organizationId: acme.id,
      accountId: piotr.accountId,
      employeeId: piotr.employeeId,
      kind: "WORK",
      startedAt: "2026-11-20T07:00:00.000Z",
      endedAt: "2026-11-20T15:00:00.000Z",
    });
    await seedEntry({
      organizationId: acme.id,
      accountId: anna.accountId,
      employeeId: anna.employeeId,
      kind: "BREAK",
      startedAt: "2026-11-20T11:00:00.000Z",
      endedAt: "2026-11-20T11:30:00.000Z",
    });

    const runner = createRemindersRunner({ db: getDb(), organizationIds: [acme.id] });
    const result = await runner.runOnce(new Date("2026-11-23T08:00:00.000Z")); // poniedziałek 09:00 CET

    expect(result.queued).toBe(1);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      organizationId: acme.id,
      idempotencyKey: `timotime-missing:${anna.employeeId}:2026-11-20`,
      body: {
        recipientAccountId: anna.accountId,
        category: "timotime.reminders",
        title: "Uzupełnij czas pracy za piątek 20.11",
        actionUrl: "http://timo-time.localhost:3300/?date=2026-11-20#moj-czas",
      },
    });
  });

  it("Jan (pn-śr 4 h) nie dostaje przypomnienia w czwartek mimo braku wpisu w środę", async () => {
    const jan = acme.addEmployee({ firstName: "Jan", lastName: "Kowalski", products: ["timotime"] });
    employeeSchedules.set(jan.employeeId, MON_WED_4H);

    const runner = createRemindersRunner({ db: getDb(), organizationIds: [acme.id] });
    const result = await runner.runOnce(new Date("2026-11-19T08:30:00.000Z")); // czwartek 09:30 CET

    expect(result.queued).toBe(0);
    expect(queued).toHaveLength(0);
  });

  it("otwarty wpis WORK od 08:00 przy grafiku 8 h uruchamia przypomnienie po 18:00", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["timotime"] });
    employeeSchedules.set(anna.employeeId, FULL_TIME);

    // Wpis za poniedziałek 16.11 oraz otwarty stoper we wtorek 17.11 od 08:00 CET (07:00Z)
    await seedEntry({
      organizationId: acme.id,
      accountId: anna.accountId,
      employeeId: anna.employeeId,
      startedAt: "2026-11-16T07:00:00.000Z",
      endedAt: "2026-11-16T15:00:00.000Z",
    });
    const openEntryId = await seedEntry({
      organizationId: acme.id,
      accountId: anna.accountId,
      employeeId: anna.employeeId,
      startedAt: "2026-11-17T07:00:00.000Z",
      endedAt: null,
    });

    const runner = createRemindersRunner({ db: getDb(), organizationIds: [acme.id] });

    // 18:00 CET -> dokładnie 10 h, bez przypomnienia
    const atSixPm = await runner.runOnce(new Date("2026-11-17T17:00:00.000Z"));
    expect(atSixPm.queued).toBe(0);

    // 18:05 CET -> powyżej 10 h, wysyła przypomnienie
    const afterSixPm = await runner.runOnce(new Date("2026-11-17T17:05:00.000Z"));
    expect(afterSixPm.queued).toBe(1);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      idempotencyKey: `timotime-timer:${openEntryId}`,
      body: {
        recipientAccountId: anna.accountId,
        category: "timotime.reminders",
        actionUrl: `http://timo-time.localhost:3300/?entry=${openEntryId}#moj-czas`,
      },
    });
  });

  it("wysyła podsumowanie tygodnia w piątek o 15:00 na podstawie wpisów z bazy (w tym otwartego stopera)", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["timotime"] });
    employeeSchedules.set(anna.employeeId, FULL_TIME);

    // Pn-czw po 8 h (32 h), pt od 08:00 CET (7 h do 15:00 CET) -> razem 39 h z 40 h -> brakuje 1 godz.
    for (const day of ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"]) {
      await seedEntry({
        organizationId: acme.id,
        accountId: anna.accountId,
        employeeId: anna.employeeId,
        startedAt: `${day}T07:00:00.000Z`,
        endedAt: `${day}T15:00:00.000Z`,
      });
    }
    await seedEntry({
      organizationId: acme.id,
      accountId: anna.accountId,
      employeeId: anna.employeeId,
      startedAt: "2026-11-20T07:00:00.000Z",
      endedAt: null,
    });

    const runner = createRemindersRunner({ db: getDb(), organizationIds: [acme.id] });
    const result = await runner.runOnce(new Date("2026-11-20T14:00:00.000Z")); // piątek 15:00 CET

    expect(result.queued).toBe(1);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      idempotencyKey: `timotime-week:${anna.employeeId}:2026-W47`,
      body: {
        recipientAccountId: anna.accountId,
        category: "timotime.reminders",
        title: "Podsumowanie tygodnia: brakuje 1 godz.",
        actionUrl: "http://timo-time.localhost:3300/?view=week&week=2026-W47#moj-czas",
      },
    });
  });

  it("pomija święto 11.11, a drugie uruchomienie nic nie wysyła (idempotencja)", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["timotime"] });
    employeeSchedules.set(anna.employeeId, FULL_TIME);

    const runner = createRemindersRunner({ db: getDb(), organizationIds: [acme.id] });

    // Środa 11.11 09:00 CET -> święto, brak przypomnienia
    const onHoliday = await runner.runOnce(new Date("2026-11-11T08:00:00.000Z"));
    expect(onHoliday.queued).toBe(0);

    // Czwartek 12.11 09:00 CET -> poprzedni dzień pracy to wtorek 10.11 (11.11 pominięte)
    const afterHoliday = await runner.runOnce(new Date("2026-11-12T08:00:00.000Z"));
    expect(afterHoliday.queued).toBe(1);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.idempotencyKey).toBe(`timotime-missing:${anna.employeeId}:2026-11-10`);

    // Drugie uruchomienie tego samego runnera: 0 nowych wysyłek
    const secondRun = await runner.runOnce(new Date("2026-11-12T08:05:00.000Z"));
    expect(secondRun.queued).toBe(0);
    expect(secondRun.deduplicated).toBe(1);
    expect(counters.notificationsRequested).toBe(1);
    expect(counters.notificationsQueued).toBe(1);

    // Restart procesu (nowy runner): Core odtwarza wynik po Idempotency-Key bez nowego e-maila
    const freshRunner = createRemindersRunner({ db: getDb(), organizationIds: [acme.id] });
    await freshRunner.runOnce(new Date("2026-11-12T08:10:00.000Z"));
    expect(counters.notificationsReplayed).toBe(1);
    expect(counters.notificationsQueued).toBe(1);
    expect(queued).toHaveLength(1);
  });

  it("odkrywa firmy z auth.sessions i izoluje wpisy między firmami przez RLS", async () => {
    const globex = fakeCore.organization({ name: "Globex", domain: "globex.test" });
    globex.grantEntitlement("timotime");
    organizationsConfig.set(globex.id, { timeZone: "Europe/Warsaw", defaultWorkSchedule: FULL_TIME });
    organizationsConfig.set(acme.id, { timeZone: "Europe/Warsaw", defaultWorkSchedule: FULL_TIME });

    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["timotime"] });
    const celina = globex.addEmployee({ firstName: "Celina", lastName: "Obca", products: ["timotime"] });

    // Wpis istnieje wyłącznie w Globex (Celina), w Acme (Anna) brak wpisu za piątek 20.11
    await seedSession(acme.id, anna.accountId);
    await seedSession(globex.id, celina.accountId);
    await seedEntry({
      organizationId: globex.id,
      accountId: celina.accountId,
      employeeId: celina.employeeId,
      startedAt: "2026-11-20T07:00:00.000Z",
      endedAt: "2026-11-20T15:00:00.000Z",
    });

    // Bez jawnego organizationIds: zadanie samo znajduje firmy przez auth.sessions
    const runner = createRemindersRunner({ db: getDb() });
    const result = await runner.runOnce(new Date("2026-11-23T08:05:00.000Z"));

    expect(result.organizationsChecked).toBeGreaterThanOrEqual(2);
    const acmeNotifs = queued.filter((item) => item.organizationId === acme.id);
    const globexNotifs = queued.filter((item) => item.organizationId === globex.id);
    expect(acmeNotifs).toHaveLength(1);
    expect(acmeNotifs[0]?.body.recipientAccountId).toBe(anna.accountId);
    expect(globexNotifs).toHaveLength(0);
  });
});
