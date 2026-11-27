/**
 * Testy jednostkowe czystych reguł przypomnień o czasie pracy (`reminders-rules.ts`):
 * polskie święta (2026: Wielkanoc 5.04, Boże Ciało 4.06), poprzedni dzień pracy, progi stopera,
 * sumy tygodnia ISO, klucze idempotencji, teksty bez form rodzajowych i obsługę zmian czasu DST.
 */
import { describe, expect, it } from "vitest";
import {
  buildForgottenTimerIdempotencyKey,
  buildForgottenTimerMessage,
  buildMissingHoursIdempotencyKey,
  buildMissingHoursMessage,
  buildWeeklySummaryIdempotencyKey,
  buildWeeklySummaryMessage,
  computeEasterSunday,
  computeWorkedMinutesInRange,
  evaluateEmployeeReminders,
  findPreviousWorkingDay,
  getForgottenTimerThresholdMinutes,
  getIsoWeek,
  getPolishPublicHolidays,
  getWeeklyScheduleSummary,
  getZonedDateTimeParts,
  isPolishPublicHoliday,
  localDayBoundsUtc,
  localStartOfDayUtc,
  roundMissingMinutesTo15,
  type ReminderEmployee,
  type ReminderTimeEntry,
  type WorkSchedule,
} from "@/server/reminders-rules";

const WARSAW = "Europe/Warsaw";

const FULL_TIME_SCHEDULE: WorkSchedule = {
  1: 480,
  2: 480,
  3: 480,
  4: 480,
  5: 480,
  6: 0,
  7: 0,
};

const PART_TIME_MON_WED: WorkSchedule = {
  1: 240,
  2: 240,
  3: 240,
};

function makeWorkEntry(overrides: {
  id?: string;
  employeeId?: string;
  accountId?: string;
  kind?: ReminderTimeEntry["kind"];
  startedAt: string;
  endedAt: string | null;
}): ReminderTimeEntry {
  return {
    id: overrides.id ?? "entry-1",
    employeeId: overrides.employeeId ?? "emp-anna",
    accountId: overrides.accountId ?? "acc-anna",
    kind: overrides.kind ?? "WORK",
    startedAt: new Date(overrides.startedAt),
    endedAt: overrides.endedAt ? new Date(overrides.endedAt) : null,
  };
}

describe("polskie dni ustawowo wolne od pracy", () => {
  it("wylicza Wielkanoc i wszystkie 14 świąt dla 2026 roku (Wielkanoc 5.04, Boże Ciało 4.06)", () => {
    expect(computeEasterSunday(2026)).toEqual({ year: 2026, month: 4, day: 5 });

    const holidays2026 = [...getPolishPublicHolidays(2026)].sort();
    expect(holidays2026).toEqual([
      "2026-01-01", // Nowy Rok
      "2026-01-06", // Trzech Króli
      "2026-04-05", // Niedziela Wielkanocna
      "2026-04-06", // Poniedziałek Wielkanocny
      "2026-05-01", // Święto Pracy
      "2026-05-03", // Konstytucji 3 Maja
      "2026-05-24", // Zielone Świątki (+49)
      "2026-06-04", // Boże Ciało (+60)
      "2026-08-15", // Wniebowzięcie NMP
      "2026-11-01", // Wszystkich Świętych
      "2026-11-11", // Święto Niepodległości
      "2026-12-24", // Wigilia Bożego Narodzenia
      "2026-12-25", // Boże Narodzenie 1
      "2026-12-26", // Boże Narodzenie 2
    ]);
    expect(isPolishPublicHoliday("2026-04-05")).toBe(true);
    expect(isPolishPublicHoliday("2026-06-04")).toBe(true);
    expect(isPolishPublicHoliday("2026-11-11")).toBe(true);
    expect(isPolishPublicHoliday("2026-12-24")).toBe(true);
    expect(isPolishPublicHoliday("2026-11-12")).toBe(false);
  });

  it("wylicza poprawnie Wielkanoc w innych latach (w tym marzec i lata przestępne)", () => {
    expect(computeEasterSunday(2024)).toEqual({ year: 2024, month: 3, day: 31 });
    expect(isPolishPublicHoliday("2024-04-01")).toBe(true); // Poniedziałek Wielkanocny
    expect(isPolishPublicHoliday("2024-05-30")).toBe(true); // Boże Ciało

    expect(computeEasterSunday(2025)).toEqual({ year: 2025, month: 4, day: 20 });
    expect(isPolishPublicHoliday("2025-06-19")).toBe(true);

    expect(computeEasterSunday(2027)).toEqual({ year: 2027, month: 3, day: 28 });
    expect(isPolishPublicHoliday("2027-05-27")).toBe(true);

    expect(computeEasterSunday(2028)).toEqual({ year: 2028, month: 4, day: 16 });
    expect(isPolishPublicHoliday("2028-06-15")).toBe(true);
  });
});

describe("poprzedni dzień pracy i obsługa nieobecności", () => {
  it("dla pełnego etatu w poniedziałek wskazuje piątek, a po świętach pomija dni wolne", () => {
    // Poniedziałek 2026-11-23 -> poprzedni dzień pracy to piątek 2026-11-20
    expect(findPreviousWorkingDay(FULL_TIME_SCHEDULE, "2026-11-23")).toBe("2026-11-20");

    // Czwartek 2026-11-12 (po święcie 11.11) -> wtorek 2026-11-10
    expect(findPreviousWorkingDay(FULL_TIME_SCHEDULE, "2026-11-12")).toBe("2026-11-10");

    // Wtorek po Wielkanocy 2026-04-07 (Poniedziałek Wielkanocny 6.04, Niedziela 5.04, Sobota 4.04) -> piątek 2026-04-03
    expect(findPreviousWorkingDay(FULL_TIME_SCHEDULE, "2026-04-07")).toBe("2026-04-03");

    // Poniedziałek 2026-12-28 (24, 25, 26 grudnia święta, 27 niedziela) -> środa 2026-12-23
    expect(findPreviousWorkingDay(FULL_TIME_SCHEDULE, "2026-12-28")).toBe("2026-12-23");
  });

  it("dla osoby bez grafiku zwraca null, a dla części etatu cofa się do jej dnia pracy", () => {
    expect(findPreviousWorkingDay(null, "2026-11-23")).toBeNull();
    // Jan (pn-śr 4 h): w poniedziałek 2026-11-23 poprzedni dzień pracy to środa 2026-11-18
    expect(findPreviousWorkingDay(PART_TIME_MON_WED, "2026-11-23")).toBe("2026-11-18");
  });

  it("cofa się co najwyżej o 14 dni i uwzględnia punkt rozszerzenia nieobecności (HiraHR)", () => {
    // Wszystkie 14 poprzednich dni jako nieobecność -> null
    expect(
      findPreviousWorkingDay(FULL_TIME_SCHEDULE, "2026-11-23", {
        isAbsent: () => true,
      }),
    ).toBeNull();

    // Piątek 2026-11-20 na urlopie -> cofa się do czwartku 2026-11-19
    expect(
      findPreviousWorkingDay(FULL_TIME_SCHEDULE, "2026-11-23", {
        isAbsent: (date) => date === "2026-11-20",
      }),
    ).toBe("2026-11-19");

    // Dokładnie 14 dni wcześniej jest dzień pracy, a dni 1..13 to urlop -> znajduje dzień -14
    const dayMinus14 = "2026-11-09";
    expect(
      findPreviousWorkingDay(FULL_TIME_SCHEDULE, "2026-11-23", {
        isAbsent: (date) => date !== dayMinus14,
      }),
    ).toBe(dayMinus14);
  });
});

describe("progi zapomnianego stopera", () => {
  it("dodaje 120 minut do grafiku w dzień pracy i używa 600 minut w dzień wolny, święto albo bez grafiku", () => {
    expect(getForgottenTimerThresholdMinutes(FULL_TIME_SCHEDULE, "2026-11-20")).toBe(600); // 480 + 120
    expect(getForgottenTimerThresholdMinutes(PART_TIME_MON_WED, "2026-11-18")).toBe(360); // 240 + 120
    expect(getForgottenTimerThresholdMinutes(FULL_TIME_SCHEDULE, "2026-11-21")).toBe(600); // sobota (wolny)
    expect(getForgottenTimerThresholdMinutes(PART_TIME_MON_WED, "2026-11-19")).toBe(600); // czwartek (wolny dla Jana)
    expect(getForgottenTimerThresholdMinutes(FULL_TIME_SCHEDULE, "2026-11-11")).toBe(600); // święto
    expect(getForgottenTimerThresholdMinutes(null, "2026-11-20")).toBe(600); // brak grafiku
    expect(getForgottenTimerThresholdMinutes(PART_TIME_MON_WED, "2026-11-18", (d) => d === "2026-11-18")).toBe(600); // urlop
  });
});

describe("sumy tygodnia ISO, ostatni dzień pracy i zaokrąglanie do 15 minut", () => {
  it("odejmuje święta z planu tygodnia i wyznacza ostatni dzień pracy tygodnia", () => {
    // Zwykły tydzień 2026-11-16..22: pełny etat 5 * 480 = 2400 min, ostatni dzień: piątek 2026-11-20
    expect(getWeeklyScheduleSummary(FULL_TIME_SCHEDULE, "2026-11-20")).toMatchObject({
      scheduledMinutes: 2400,
      lastWorkingDay: "2026-11-20",
    });

    // Tydzień ze świętem 11.11 (środa): 4 * 480 = 1920 min, ostatni dzień: piątek 2026-11-13
    expect(getWeeklyScheduleSummary(FULL_TIME_SCHEDULE, "2026-11-13")).toMatchObject({
      scheduledMinutes: 1920,
      lastWorkingDay: "2026-11-13",
    });

    // Tydzień z 1.05 w piątek (2026-04-27..05-03): ostatni dzień pracy to czwartek 2026-04-30
    expect(getWeeklyScheduleSummary(FULL_TIME_SCHEDULE, "2026-04-30")).toMatchObject({
      scheduledMinutes: 1920,
      lastWorkingDay: "2026-04-30",
    });

    // Jan (pn-śr 4 h): ostatni dzień pracy to środa 2026-11-18, plan 720 min
    expect(getWeeklyScheduleSummary(PART_TIME_MON_WED, "2026-11-18")).toMatchObject({
      scheduledMinutes: 720,
      lastWorkingDay: "2026-11-18",
    });

    // Brak grafiku -> 0 i null
    expect(getWeeklyScheduleSummary(null, "2026-11-20")).toMatchObject({
      scheduledMinutes: 0,
      lastWorkingDay: null,
    });
  });

  it("liczy przepracowane minuty z wpisów WORK (łącznie z trwającym stoperem do chwili now) i przycina nocne zmiany", () => {
    const weekStart = localStartOfDayUtc("2026-11-16", WARSAW); // poniedziałek 00:00 CET = 2026-11-15T23:00Z
    const weekEnd = localStartOfDayUtc("2026-11-23", WARSAW); // kolejny poniedziałek 00:00 CET
    const now = new Date("2026-11-20T14:00:00.000Z"); // piątek 15:00 CET

    const entries: ReminderTimeEntry[] = [
      // Nocna zmiana z niedzieli na poniedziałek (22:00-02:00 CET): w tygodniu tylko 2 h (120 min)
      makeWorkEntry({
        id: "night",
        startedAt: "2026-11-15T21:00:00.000Z",
        endedAt: "2026-11-16T01:00:00.000Z",
      }),
      // Przerwa i praca zdalna nie wchodzą do wpisów WORK
      makeWorkEntry({
        id: "break",
        kind: "BREAK",
        startedAt: "2026-11-16T10:00:00.000Z",
        endedAt: "2026-11-16T10:30:00.000Z",
      }),
      makeWorkEntry({
        id: "remote",
        kind: "REMOTE",
        startedAt: "2026-11-17T08:00:00.000Z",
        endedAt: "2026-11-17T16:00:00.000Z",
      }),
      // Otwarty wpis WORK w piątek od 08:00 CET (07:00Z) do 15:00 CET (14:00Z) = 7 h (420 min)
      makeWorkEntry({
        id: "running",
        startedAt: "2026-11-20T07:00:00.000Z",
        endedAt: null,
      }),
    ];

    expect(computeWorkedMinutesInRange(entries, weekStart, weekEnd, now)).toBe(540); // 120 + 420
  });

  it("zaokrągla brakujące minuty do 15 minut z minimum 15 min dla dodatniego niedoboru", () => {
    expect(roundMissingMinutesTo15(0)).toBe(0);
    expect(roundMissingMinutesTo15(-10)).toBe(0);
    expect(roundMissingMinutesTo15(5)).toBe(15);
    expect(roundMissingMinutesTo15(22)).toBe(15);
    expect(roundMissingMinutesTo15(23)).toBe(30);
    expect(roundMissingMinutesTo15(52)).toBe(45);
    expect(roundMissingMinutesTo15(53)).toBe(60);
    expect(roundMissingMinutesTo15(100)).toBe(105);
    expect(roundMissingMinutesTo15(120)).toBe(120);
  });

  it("wylicza numery tygodni ISO na przełomie roku", () => {
    expect(getIsoWeek("2025-12-29")).toEqual({ isoYear: 2026, isoWeek: 1, key: "2026-W01" });
    expect(getIsoWeek("2026-01-01")).toEqual({ isoYear: 2026, isoWeek: 1, key: "2026-W01" });
    expect(getIsoWeek("2026-11-20")).toEqual({ isoYear: 2026, isoWeek: 47, key: "2026-W47" });
    expect(getIsoWeek("2026-12-31")).toEqual({ isoYear: 2026, isoWeek: 53, key: "2026-W53" });
    expect(getIsoWeek("2027-01-01")).toEqual({ isoYear: 2026, isoWeek: 53, key: "2026-W53" });
  });
});

describe("obsługa czasu lokalnego przy zmianach czasu (DST: ostatnia niedziela marca i października)", () => {
  it("poprawnie liczy 23-godzinną dobę w ostatnią niedzielę marca 2026 (29.03) i próg 09:00 CEST", () => {
    // 2026-03-29 w Europe/Warsaw: 00:00 CET = 28.03 23:00Z, 2026-03-30 00:00 CEST = 29.03 22:00Z -> 23 godz.
    const springBounds = localDayBoundsUtc("2026-03-29", WARSAW);
    expect(springBounds.start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(springBounds.endExclusive.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(springBounds.endExclusive.getTime() - springBounds.start.getTime()).toBe(23 * 60 * 60 * 1000);

    // Poniedziałek 2026-03-30 po zmianie na czas letni (UTC+2): 06:59Z to 08:59 lokalnie, 07:00Z to 09:00 lokalnie
    const anna: ReminderEmployee = { id: "emp-anna", accountId: "acc-anna", effectiveWorkSchedule: FULL_TIME_SCHEDULE };
    expect(
      evaluateEmployeeReminders({
        employee: anna,
        entries: [],
        now: new Date("2026-03-30T06:59:59.000Z"),
        timeZone: WARSAW,
      }),
    ).toEqual([]);

    const atNineCest = evaluateEmployeeReminders({
      employee: anna,
      entries: [],
      now: new Date("2026-03-30T07:00:00.000Z"),
      timeZone: WARSAW,
    });
    expect(atNineCest).toHaveLength(1);
    expect(atNineCest[0]?.idempotencyKey).toBe("timotime-missing:emp-anna:2026-03-27");

    // Stoper przez zmianę czasu (sobota 22:00 CET = 21:00Z -> niedziela 09:00 CEST = 07:00Z): dokładnie 10 h (600 min), nie 11 h!
    const nightTimer = makeWorkEntry({
      id: "dst-spring-timer",
      startedAt: "2026-03-28T21:00:00.000Z",
      endedAt: null,
    });
    expect(
      evaluateEmployeeReminders({
        employee: anna,
        entries: [nightTimer],
        now: new Date("2026-03-29T07:00:00.000Z"), // dokładnie 600 min -> jeszcze nie > 600
        timeZone: WARSAW,
      }),
    ).toEqual([]);
    expect(
      evaluateEmployeeReminders({
        employee: anna,
        entries: [nightTimer],
        now: new Date("2026-03-29T07:01:00.000Z"), // 601 min -> przekracza 600 min
        timeZone: WARSAW,
      }).map((r) => r.idempotencyKey),
    ).toEqual(["timotime-timer:dst-spring-timer"]);
  });

  it("poprawnie liczy 25-godzinną dobę w ostatnią niedzielę października 2026 (25.10) i próg 09:00 CET", () => {
    // 2026-10-25 w Europe/Warsaw: 00:00 CEST = 24.10 22:00Z, 2026-10-26 00:00 CET = 25.10 23:00Z -> 25 godz.
    const autumnBounds = localDayBoundsUtc("2026-10-25", WARSAW);
    expect(autumnBounds.start.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(autumnBounds.endExclusive.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(autumnBounds.endExclusive.getTime() - autumnBounds.start.getTime()).toBe(25 * 60 * 60 * 1000);

    // Poniedziałek 2026-10-26 po zmianie na czas zimowy (UTC+1): 07:59Z to 08:59 lokalnie, 08:00Z to 09:00 lokalnie
    expect(getZonedDateTimeParts(new Date("2026-10-26T07:59:00.000Z"), WARSAW).hour).toBe(8);
    expect(getZonedDateTimeParts(new Date("2026-10-26T08:00:00.000Z"), WARSAW).hour).toBe(9);

    const anna: ReminderEmployee = { id: "emp-anna", accountId: "acc-anna", effectiveWorkSchedule: FULL_TIME_SCHEDULE };
    expect(
      evaluateEmployeeReminders({
        employee: anna,
        entries: [],
        now: new Date("2026-10-26T07:59:59.000Z"),
        timeZone: WARSAW,
      }),
    ).toEqual([]);

    const atNineCet = evaluateEmployeeReminders({
      employee: anna,
      entries: [],
      now: new Date("2026-10-26T08:00:00.000Z"),
      timeZone: WARSAW,
    });
    expect(atNineCet).toHaveLength(1);
    expect(atNineCet[0]?.idempotencyKey).toBe("timotime-missing:emp-anna:2026-10-23");

    // Stoper przez cofnięcie zegara (sobota 22:00 CEST = 20:00Z -> niedziela 07:01 CET = 06:01Z): realnie 10 h 01 min (601 min)!
    const autumnTimer = makeWorkEntry({
      id: "dst-autumn-timer",
      startedAt: "2026-10-24T20:00:00.000Z",
      endedAt: null,
    });
    expect(
      evaluateEmployeeReminders({
        employee: anna,
        entries: [autumnTimer],
        now: new Date("2026-10-25T06:00:00.000Z"), // dokładnie 600 min
        timeZone: WARSAW,
      }),
    ).toEqual([]);
    expect(
      evaluateEmployeeReminders({
        employee: anna,
        entries: [autumnTimer],
        now: new Date("2026-10-25T06:01:00.000Z"), // 601 min
        timeZone: WARSAW,
      }).map((r) => r.idempotencyKey),
    ).toEqual(["timotime-timer:dst-autumn-timer"]);
  });
});

describe("deterministyczne klucze idempotencji i teksty w neutralnym języku polskim", () => {
  it("generuje poprawne, deterministyczne klucze Idempotency-Key (drukowalne ASCII <= 255)", () => {
    const keys = [
      buildMissingHoursIdempotencyKey("019a0000-0000-7000-8000-000000000001", "2026-11-20"),
      buildForgottenTimerIdempotencyKey("019a0000-0000-7000-8000-000000000002"),
      buildWeeklySummaryIdempotencyKey("019a0000-0000-7000-8000-000000000001", "2026-W47"),
    ];

    expect(keys).toEqual([
      "timotime-missing:019a0000-0000-7000-8000-000000000001:2026-11-20",
      "timotime-timer:019a0000-0000-7000-8000-000000000002",
      "timotime-week:019a0000-0000-7000-8000-000000000001:2026-W47",
    ]);

    for (const key of keys) {
      expect(key.length).toBeGreaterThanOrEqual(1);
      expect(key.length).toBeLessThanOrEqual(255);
      expect(/^[\x21-\x7E]+$/.test(key)).toBe(true);
    }
  });

  it("buduje teksty po polsku bez form rodzajowych i bez półpauz", () => {
    const missingFriday = buildMissingHoursMessage("2025-11-21"); // piątek 21.11
    expect(missingFriday).toEqual({
      title: "Uzupełnij czas pracy za piątek 21.11",
      body: "W TimoTime nie ma wpisu za piątek 21 listopada, a według Twojego grafiku to dzień pracy.",
    });

    // Biernik środy, soboty i niedzieli
    expect(buildMissingHoursMessage("2026-11-18").title).toBe("Uzupełnij czas pracy za środę 18.11");
    expect(buildMissingHoursMessage("2026-11-21").title).toBe("Uzupełnij czas pracy za sobotę 21.11");
    expect(buildMissingHoursMessage("2026-11-22").title).toBe("Uzupełnij czas pracy za niedzielę 22.11");

    const timerMsg = buildForgottenTimerMessage({
      startedAt: new Date("2026-11-20T07:00:00.000Z"), // 08:00 CET
      now: new Date("2026-11-20T17:05:00.000Z"), // 18:05 CET -> 10 godz. 5 min
      timeZone: WARSAW,
    });
    expect(timerMsg).toEqual({
      title: "Sprawdź otwarty wpis czasu pracy",
      body: "Wpis pracy rozpoczęty o 08:00 nadal trwa (10 godz. 5 min). Jeśli dzień pracy już się skończył, zatrzymaj stoper w TimoTime.",
    });

    const weeklyMsg = buildWeeklySummaryMessage({
      workedMinutes: 2260, // 37 godz. 40 min
      scheduledMinutes: 2400, // 40 godz.
      missingRoundedMinutes: 135, // 2 godz. 15 min
    });
    expect(weeklyMsg).toEqual({
      title: "Podsumowanie tygodnia: brakuje 2 godz. 15 min",
      body: "W tym tygodniu zarejestrowano 37 godz. 40 min pracy z planowanych 40 godz. (brakuje około 2 godz. 15 min). Sprawdź swoje wpisy w TimoTime.",
    });

    for (const text of [
      missingFriday.title,
      missingFriday.body,
      timerMsg.title,
      timerMsg.body,
      weeklyMsg.title,
      weeklyMsg.body,
    ]) {
      expect(text).not.toMatch(/[–—]/);
      expect(text).not.toMatch(/(?:aś|eś)(?=$|[\s.,!?])/iu);
    }
  });
});
