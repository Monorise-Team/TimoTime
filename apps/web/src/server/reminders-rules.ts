/**
 * Czyste reguły przypomnień o czasie pracy (TimoTime#41):
 * - polskie święta ustawowo wolne od pracy (stałe i ruchome od Wielkanocy),
 * - operacje na czasie lokalnym w strefie IANA firmy z obsługą zmian czasu (DST),
 * - wyliczanie poprzedniego dnia pracy, progów zapomnianego stopera i sum tygodnia ISO,
 * - deterministyczne klucze `Idempotency-Key` oraz neutralne płciowo teksty po polsku.
 *
 * Moduł jest całkowicie czysty (bez I/O i bez `server-only`), więc testy jednostkowe mogą
 * go wywoływać bezpośrednio z dowolnym zegarem i dowolną strefą czasową.
 */

export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type IsoWeekdayKey = "1" | "2" | "3" | "4" | "5" | "6" | "7";

/** Data kalendarzowa w strefie firmy w formacie `YYYY-MM-DD`. */
export type LocalDateString = string;

export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface ZonedDateTimeParts extends LocalDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly isoWeekday: IsoWeekday;
  readonly dateKey: LocalDateString;
}

/** Harmonogram pracy z MonoriseCore: minuty pracy na dzień tygodnia ISO `"1"`..`"7"`. */
export interface WorkSchedule {
  readonly 1?: number;
  readonly 2?: number;
  readonly 3?: number;
  readonly 4?: number;
  readonly 5?: number;
  readonly 6?: number;
  readonly 7?: number;
}

export interface ReminderTimeEntry {
  readonly id: string;
  readonly employeeId: string;
  readonly accountId: string;
  readonly kind: "WORK" | "BREAK" | "REMOTE" | "BUSINESS_TRIP";
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

export interface ReminderEmployee {
  readonly id: string;
  readonly accountId: string;
  readonly effectiveWorkSchedule: WorkSchedule | null;
}

/**
 * Punkt rozszerzenia dla nieobecności i urlopów (docelowo HiraHR): zwraca `true`,
 * gdy dany dzień lokalny (`YYYY-MM-DD`) powinien być traktowany jako dzień wolny pracownika.
 */
export type EmployeeDayOffPredicate = (dateKey: LocalDateString) => boolean;

export type ReminderKind = "missing-hours" | "forgotten-timer" | "weekly-summary";

export type ReminderActionTarget =
  | { readonly type: "missing-hours"; readonly date: LocalDateString }
  | { readonly type: "forgotten-timer"; readonly entryId: string }
  | { readonly type: "weekly-summary"; readonly isoWeekKey: string };

export interface ReminderCandidate {
  readonly kind: ReminderKind;
  readonly employeeId: string;
  readonly recipientAccountId: string;
  readonly idempotencyKey: string;
  readonly title: string;
  readonly body: string;
  readonly actionTarget: ReminderActionTarget;
}

export const DEFAULT_MISSING_HOURS_LOOKBACK_DAYS = 14;
export const MISSING_HOURS_TRIGGER_HOUR = 9;
export const WEEKLY_SUMMARY_TRIGGER_HOUR = 15;
export const FORGOTTEN_TIMER_BUFFER_MINUTES = 120;
export const FORGOTTEN_TIMER_FALLBACK_MINUTES = 600;
export const WEEKLY_MISSING_ROUNDING_MINUTES = 15;

const FIXED_POLISH_HOLIDAYS: readonly (readonly [number, number])[] = [
  [1, 1], // Nowy Rok
  [1, 6], // Święto Trzech Króli
  [5, 1], // Święto Pracy
  [5, 3], // Święto Konstytucji 3 Maja
  [8, 15], // Wniebowzięcie Najświętszej Maryi Panny
  [11, 1], // Wszystkich Świętych
  [11, 11], // Narodowe Święto Niepodległości
  [12, 24], // Wigilia Bożego Narodzenia
  [12, 25], // Pierwszy dzień Bożego Narodzenia
  [12, 26], // Drugi dzień Bożego Narodzenia
];

const POLISH_WEEKDAYS_ACCUSATIVE: Readonly<Record<IsoWeekday, string>> = {
  1: "poniedziałek",
  2: "wtorek",
  3: "środę",
  4: "czwartek",
  5: "piątek",
  6: "sobotę",
  7: "niedzielę",
};

const POLISH_MONTHS_GENITIVE: readonly string[] = [
  "stycznia",
  "lutego",
  "marca",
  "kwietnia",
  "maja",
  "czerwca",
  "lipca",
  "sierpnia",
  "września",
  "października",
  "listopada",
  "grudnia",
];

const polishHolidaysByYear = new Map<number, ReadonlySet<LocalDateString>>();
const zonedFormatterCache = new Map<string, Intl.DateTimeFormat>();

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function pad4(value: number): string {
  return String(value).padStart(4, "0");
}

export function formatLocalDate(date: LocalDate): LocalDateString {
  return `${pad4(date.year)}-${pad2(date.month)}-${pad2(date.day)}`;
}

export function parseLocalDate(dateKey: LocalDateString): LocalDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) {
    throw new RangeError(`Nieprawidłowy format daty lokalnej: "${dateKey}" (oczekiwano YYYY-MM-DD)`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) {
    throw new RangeError(`Nieistniejąca data kalendarzowa: "${dateKey}"`);
  }
  return { year, month, day };
}

/** Przesuwa datę kalendarzową o zadaną liczbę dni (niezależnie od strefy czasowej i DST). */
export function addDaysToLocalDate(dateKey: LocalDateString, deltaDays: number): LocalDateString {
  const { year, month, day } = parseLocalDate(dateKey);
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return formatLocalDate({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

/** Zwraca dzień tygodnia ISO (`1` = poniedziałek .. `7` = niedziela) dla daty `YYYY-MM-DD`. */
export function getIsoWeekday(dateKey: LocalDateString): IsoWeekday {
  const { year, month, day } = parseLocalDate(dateKey);
  const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (utcDay === 0 ? 7 : utcDay) as IsoWeekday;
}

/** Zwraca rok i numer tygodnia ISO-8601 (np. `{ isoYear: 2026, isoWeek: 47, key: "2026-W47" }`). */
export function getIsoWeek(dateKey: LocalDateString): {
  readonly isoYear: number;
  readonly isoWeek: number;
  readonly key: string;
} {
  const { year, month, day } = parseLocalDate(dateKey);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const dayNum = utc.getUTCDay() || 7;
  // Czwartek danego tygodnia ISO zawsze należy do właściwego roku tygodnia ISO.
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const isoYear = utc.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const isoWeek = Math.ceil(((utc.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return {
    isoYear,
    isoWeek,
    key: `${pad4(isoYear)}-W${pad2(isoWeek)}`,
  };
}

/** Zwraca 7 kolejnych dat kalendarzowych tygodnia ISO (poniedziałek .. niedziela) zawierającego `dateKey`. */
export function getIsoWeekDates(dateKey: LocalDateString): readonly LocalDateString[] {
  const weekday = getIsoWeekday(dateKey);
  const monday = addDaysToLocalDate(dateKey, -(weekday - 1));
  const dates: LocalDateString[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    dates.push(addDaysToLocalDate(monday, offset));
  }
  return dates;
}

/**
 * Wylicza datę Wielkanocy (Niedzieli Wielkanocnej) w kalendarzu gregoriańskim
 * algorytmem Meeusa/Jonesa/Butchera.
 */
export function computeEasterSunday(year: number): LocalDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}

/**
 * Zwraca zbiór dat (`YYYY-MM-DD`) wszystkich 14 polskich dni ustawowo wolnych od pracy
 * dla wskazanego roku (10 stałych łącznie z 24.12 oraz 4 ruchome zależne od Wielkanocy).
 */
export function getPolishPublicHolidays(year: number): ReadonlySet<LocalDateString> {
  const cached = polishHolidaysByYear.get(year);
  if (cached) return cached;

  const holidays = new Set<LocalDateString>();
  for (const [month, day] of FIXED_POLISH_HOLIDAYS) {
    holidays.add(formatLocalDate({ year, month, day }));
  }

  const easterKey = formatLocalDate(computeEasterSunday(year));
  holidays.add(easterKey); // Niedziela Wielkanocna
  holidays.add(addDaysToLocalDate(easterKey, 1)); // Poniedziałek Wielkanocny
  holidays.add(addDaysToLocalDate(easterKey, 49)); // Zielone Świątki (Niedziela Zesłania Ducha Świętego)
  holidays.add(addDaysToLocalDate(easterKey, 60)); // Boże Ciało

  polishHolidaysByYear.set(year, holidays);
  return holidays;
}

export function isPolishPublicHoliday(dateKey: LocalDateString): boolean {
  const { year } = parseLocalDate(dateKey);
  return getPolishPublicHolidays(year).has(dateKey);
}

function getZonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zonedFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    zonedFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidIanaTimeZone(timeZone: string): boolean {
  if (!timeZone.trim()) return false;
  try {
    getZonedFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Odczytuje składowe lokalnej daty i godziny chwili `instant` w strefie IANA `timeZone`. */
export function getZonedDateTimeParts(instant: Date, timeZone: string): ZonedDateTimeParts {
  const parts = getZonedFormatter(timeZone).formatToParts(instant);
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;

  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value) % 24;
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "second":
        second = Number(part.value);
        break;
    }
  }

  const dateKey = formatLocalDate({ year, month, day });
  const isoWeekday = getIsoWeekday(dateKey);
  return { year, month, day, hour, minute, second, isoWeekday, dateKey };
}

function getTimeZoneOffsetMs(instantMs: number, timeZone: string): number {
  const wholeSecondsMs = Math.floor(instantMs / 1000) * 1000;
  const parts = getZonedDateTimeParts(new Date(wholeSecondsMs), timeZone);
  const asUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtcMs - wholeSecondsMs;
}

/**
 * Zwraca dokładną chwilę UTC odpowiadającą lokalnej północy `00:00:00.000` dnia `dateKey`
 * w strefie IANA `timeZone` (poprawnie obsługuje doby 23- i 25-godzinne przy zmianie czasu DST).
 */
export function localStartOfDayUtc(dateKey: LocalDateString, timeZone: string): Date {
  const { year, month, day } = parseLocalDate(dateKey);
  const targetUtcGuess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offset1 = getTimeZoneOffsetMs(targetUtcGuess, timeZone);
  let candidate = targetUtcGuess - offset1;
  const offset2 = getTimeZoneOffsetMs(candidate, timeZone);
  if (offset2 !== offset1) {
    candidate = targetUtcGuess - offset2;
  }
  const check = getZonedDateTimeParts(new Date(candidate), timeZone);
  if (check.dateKey !== dateKey) {
    candidate = targetUtcGuess - offset1;
  }
  return new Date(candidate);
}

/** Zwraca półotwarty przedział UTC `[start, endExclusive)` dla dnia lokalnego `dateKey` w strefie `timeZone`. */
export function localDayBoundsUtc(
  dateKey: LocalDateString,
  timeZone: string,
): { readonly start: Date; readonly endExclusive: Date } {
  return {
    start: localStartOfDayUtc(dateKey, timeZone),
    endExclusive: localStartOfDayUtc(addDaysToLocalDate(dateKey, 1), timeZone),
  };
}

/** Zwraca zaplanowaną liczbę minut pracy dla daty `dateKey` według harmonogramu (0 przy braku wpisu). */
export function getScheduledMinutesForDate(schedule: WorkSchedule | null, dateKey: LocalDateString): number {
  if (!schedule) return 0;
  const weekdayKey = String(getIsoWeekday(dateKey)) as IsoWeekdayKey;
  const value = schedule[weekdayKey];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

/**
 * Rozstrzyga, czy dzień `dateKey` jest dniem pracy pracownika: harmonogram > 0 minut,
 * brak polskiego święta ustawowego oraz brak nieobecności (punkt rozszerzenia HiraHR).
 */
export function isWorkingDay(
  schedule: WorkSchedule | null,
  dateKey: LocalDateString,
  isAbsent?: EmployeeDayOffPredicate,
): boolean {
  if (!schedule) return false;
  if (getScheduledMinutesForDate(schedule, dateKey) <= 0) return false;
  if (isPolishPublicHoliday(dateKey)) return false;
  if (isAbsent?.(dateKey)) return false;
  return true;
}

/**
 * Znajduje poprzedni dzień pracy pracownika (z pominięciem dni wolnych z grafiku, polskich świąt
 * i ewentualnych nieobecności), cofając się co najwyżej o `maxLookbackDays` dni (domyślnie 14).
 */
export function findPreviousWorkingDay(
  schedule: WorkSchedule | null,
  today: LocalDateString,
  options: {
    readonly maxLookbackDays?: number;
    readonly isAbsent?: EmployeeDayOffPredicate;
  } = {},
): LocalDateString | null {
  if (!schedule) return null;
  const maxLookbackDays = options.maxLookbackDays ?? DEFAULT_MISSING_HOURS_LOOKBACK_DAYS;
  for (let offset = 1; offset <= maxLookbackDays; offset += 1) {
    const candidate = addDaysToLocalDate(today, -offset);
    if (isWorkingDay(schedule, candidate, options.isAbsent)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Próg czasu trwania (w minutach) dla przypomnienia o zapomnianym stoperze:
 * - dzień pracy z grafiku (nie święto i nie nieobecność): minuty z grafiku + 120 min,
 * - brak grafiku albo dzień wolny / święto: 600 min.
 */
export function getForgottenTimerThresholdMinutes(
  schedule: WorkSchedule | null,
  startDateKey: LocalDateString,
  isAbsent?: EmployeeDayOffPredicate,
): number {
  if (!isWorkingDay(schedule, startDateKey, isAbsent)) {
    return FORGOTTEN_TIMER_FALLBACK_MINUTES;
  }
  return getScheduledMinutesForDate(schedule, startDateKey) + FORGOTTEN_TIMER_BUFFER_MINUTES;
}

/**
 * Wylicza planowany czas pracy tygodnia ISO (pomniejszony o święta i nieobecności)
 * oraz ostatni dzień pracy pracownika w tym tygodniu ISO.
 */
export function getWeeklyScheduleSummary(
  schedule: WorkSchedule | null,
  today: LocalDateString,
  isAbsent?: EmployeeDayOffPredicate,
): {
  readonly weekDates: readonly LocalDateString[];
  readonly scheduledMinutes: number;
  readonly lastWorkingDay: LocalDateString | null;
} {
  const weekDates = getIsoWeekDates(today);
  if (!schedule) {
    return { weekDates, scheduledMinutes: 0, lastWorkingDay: null };
  }

  let scheduledMinutes = 0;
  let lastWorkingDay: LocalDateString | null = null;
  for (const dateKey of weekDates) {
    if (isWorkingDay(schedule, dateKey, isAbsent)) {
      scheduledMinutes += getScheduledMinutesForDate(schedule, dateKey);
      lastWorkingDay = dateKey;
    }
  }
  return { weekDates, scheduledMinutes, lastWorkingDay };
}

/** Sprawdza, czy pracownik ma jakikolwiek wpis rodzaju `WORK` nakładający się na lokalny dzień `dateKey`. */
export function hasWorkEntryOnDay(
  entries: readonly ReminderTimeEntry[],
  dateKey: LocalDateString,
  timeZone: string,
  now: Date,
): boolean {
  const { start, endExclusive } = localDayBoundsUtc(dateKey, timeZone);
  const dayStartMs = start.getTime();
  const dayEndMs = endExclusive.getTime();
  const nowMs = now.getTime();

  for (const entry of entries) {
    if (entry.kind !== "WORK") continue;
    const startMs = entry.startedAt.getTime();
    const endMs = entry.endedAt ? entry.endedAt.getTime() : Math.max(nowMs, startMs);
    if (endMs > startMs) {
      if (startMs < dayEndMs && endMs > dayStartMs) {
        return true;
      }
    } else if (startMs >= dayStartMs && startMs < dayEndMs) {
      return true;
    }
  }

  return false;
}

/**
 * Liczy łączną liczbę przepracowanych minut (`kind === "WORK"`) w przedziale `[rangeStart, rangeEndExclusive)`.
 * Otwarte wpisy (`endedAt === null`) liczone są do chwili `now`.
 */
export function computeWorkedMinutesInRange(
  entries: readonly ReminderTimeEntry[],
  rangeStart: Date,
  rangeEndExclusive: Date,
  now: Date,
): number {
  const rangeStartMs = rangeStart.getTime();
  const rangeEndMs = rangeEndExclusive.getTime();
  const nowMs = now.getTime();
  let totalMs = 0;

  for (const entry of entries) {
    if (entry.kind !== "WORK") continue;
    const startMs = entry.startedAt.getTime();
    const endMs = entry.endedAt ? entry.endedAt.getTime() : nowMs;
    if (endMs <= startMs) continue;

    const clampedStart = Math.max(startMs, rangeStartMs);
    const clampedEnd = Math.min(endMs, rangeEndMs);
    if (clampedEnd > clampedStart) {
      totalMs += clampedEnd - clampedStart;
    }
  }

  return Math.floor(totalMs / 60_000);
}

/**
 * Zaokrągla brakujący czas (w minutach) do najbliższych 15 minut, zachowując minimum 15 min
 * dla dowolnego dodatniego niedoboru, aby komunikat nie wskazywał „0 min”.
 */
export function roundMissingMinutesTo15(missingMinutes: number): number {
  if (missingMinutes <= 0) return 0;
  return Math.max(
    WEEKLY_MISSING_ROUNDING_MINUTES,
    Math.round(missingMinutes / WEEKLY_MISSING_ROUNDING_MINUTES) * WEEKLY_MISSING_ROUNDING_MINUTES,
  );
}

// ── Deterministyczne klucze Idempotency-Key ─────────────────────────────────

export function buildMissingHoursIdempotencyKey(employeeId: string, dateKey: LocalDateString): string {
  return `timotime-missing:${employeeId}:${dateKey}`;
}

export function buildForgottenTimerIdempotencyKey(entryId: string): string {
  return `timotime-timer:${entryId}`;
}

export function buildWeeklySummaryIdempotencyKey(employeeId: string, isoWeekKey: string): string {
  return `timotime-week:${employeeId}:${isoWeekKey}`;
}

// ── Neutralne płciowo teksty przypomnień po polsku ──────────────────────────

/** Np. „piątek 21.11”. */
export function formatPolishWeekdayShortDate(dateKey: LocalDateString): string {
  const { month, day } = parseLocalDate(dateKey);
  const weekday = POLISH_WEEKDAYS_ACCUSATIVE[getIsoWeekday(dateKey)];
  return `${weekday} ${pad2(day)}.${pad2(month)}`;
}

/** Np. „piątek 21 listopada”. */
export function formatPolishWeekdayLongDate(dateKey: LocalDateString): string {
  const { month, day } = parseLocalDate(dateKey);
  const weekday = POLISH_WEEKDAYS_ACCUSATIVE[getIsoWeekday(dateKey)];
  const monthName = POLISH_MONTHS_GENITIVE[month - 1]!;
  return `${weekday} ${day} ${monthName}`;
}

/** Formatuje liczbę minut w czytelny sposób po polsku (np. „2 godz. 15 min”, „1 godz.”, „45 min”). */
export function formatPolishMinutes(totalMinutes: number): string {
  const clamped = Math.max(0, Math.floor(totalMinutes));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  if (hours > 0 && minutes > 0) return `${hours} godz. ${minutes} min`;
  if (hours > 0) return `${hours} godz.`;
  return `${minutes} min`;
}

export function buildMissingHoursMessage(dateKey: LocalDateString): { readonly title: string; readonly body: string } {
  return {
    title: `Uzupełnij czas pracy za ${formatPolishWeekdayShortDate(dateKey)}`,
    body: `W TimoTime nie ma wpisu za ${formatPolishWeekdayLongDate(dateKey)}, a według Twojego grafiku to dzień pracy.`,
  };
}

export function buildForgottenTimerMessage(params: {
  readonly startedAt: Date;
  readonly now: Date;
  readonly timeZone: string;
}): { readonly title: string; readonly body: string } {
  const startParts = getZonedDateTimeParts(params.startedAt, params.timeZone);
  const nowParts = getZonedDateTimeParts(params.now, params.timeZone);
  const startTime = `${pad2(startParts.hour)}:${pad2(startParts.minute)}`;
  const elapsedMinutes = Math.max(0, Math.floor((params.now.getTime() - params.startedAt.getTime()) / 60_000));
  const durationText = formatPolishMinutes(elapsedMinutes);

  const startedPhrase =
    startParts.dateKey === nowParts.dateKey
      ? `o ${startTime}`
      : `${startParts.day} ${POLISH_MONTHS_GENITIVE[startParts.month - 1]!} o ${startTime}`;

  return {
    title: "Sprawdź otwarty wpis czasu pracy",
    body: `Wpis pracy rozpoczęty ${startedPhrase} nadal trwa (${durationText}). Jeśli dzień pracy już się skończył, zatrzymaj stoper w TimoTime.`,
  };
}

export function buildWeeklySummaryMessage(params: {
  readonly workedMinutes: number;
  readonly scheduledMinutes: number;
  readonly missingRoundedMinutes: number;
}): { readonly title: string; readonly body: string } {
  const missingText = formatPolishMinutes(params.missingRoundedMinutes);
  const workedText = formatPolishMinutes(params.workedMinutes);
  const scheduledText = formatPolishMinutes(params.scheduledMinutes);

  return {
    title: `Podsumowanie tygodnia: brakuje ${missingText}`,
    body: `W tym tygodniu zarejestrowano ${workedText} pracy z planowanych ${scheduledText} (brakuje około ${missingText}). Sprawdź swoje wpisy w TimoTime.`,
  };
}

// ── Ewaluacja wszystkich 3 reguł dla jednego pracownika ─────────────────────

export interface EvaluateEmployeeRemindersInput {
  readonly employee: ReminderEmployee;
  readonly entries: readonly ReminderTimeEntry[];
  readonly now: Date;
  readonly timeZone: string;
  readonly isAbsent?: EmployeeDayOffPredicate;
}

/**
 * Wylicza wszystkie przypomnienia należne pracownikowi w chwili `now` (w strefie `timeZone`):
 * 1. Brak godzin (od 09:00 lokalnie w dzień pracy, gdy poprzedni dzień pracy nie ma wpisu WORK),
 * 2. Zapomniany stoper (otwarty wpis WORK trwający dłużej niż grafik dnia startu + 120 min albo 600 min),
 * 3. Podsumowanie tygodnia (od 15:00 lokalnie w ostatni dzień pracy tygodnia ISO poniżej planu).
 */
export function evaluateEmployeeReminders(input: EvaluateEmployeeRemindersInput): ReminderCandidate[] {
  const { employee, entries, now, timeZone, isAbsent } = input;
  const schedule = employee.effectiveWorkSchedule;
  const localNow = getZonedDateTimeParts(now, timeZone);
  const today = localNow.dateKey;
  const reminders: ReminderCandidate[] = [];

  // 1. Brak godzin („brak godzin”)
  if (schedule && localNow.hour >= MISSING_HOURS_TRIGGER_HOUR && isWorkingDay(schedule, today, isAbsent)) {
    const previousWorkingDay = findPreviousWorkingDay(schedule, today, {
      maxLookbackDays: DEFAULT_MISSING_HOURS_LOOKBACK_DAYS,
      isAbsent,
    });
    if (previousWorkingDay && !hasWorkEntryOnDay(entries, previousWorkingDay, timeZone, now)) {
      const message = buildMissingHoursMessage(previousWorkingDay);
      reminders.push({
        kind: "missing-hours",
        employeeId: employee.id,
        recipientAccountId: employee.accountId,
        idempotencyKey: buildMissingHoursIdempotencyKey(employee.id, previousWorkingDay),
        title: message.title,
        body: message.body,
        actionTarget: { type: "missing-hours", date: previousWorkingDay },
      });
    }
  }

  // 2. Zapomniany stoper („zapomniany stoper”)
  const nowMs = now.getTime();
  for (const entry of entries) {
    if (entry.kind !== "WORK" || entry.endedAt !== null) continue;
    const elapsedMs = nowMs - entry.startedAt.getTime();
    if (elapsedMs <= 0) continue;

    const startDateKey = getZonedDateTimeParts(entry.startedAt, timeZone).dateKey;
    const thresholdMinutes = getForgottenTimerThresholdMinutes(schedule, startDateKey, isAbsent);
    if (elapsedMs > thresholdMinutes * 60_000) {
      const message = buildForgottenTimerMessage({ startedAt: entry.startedAt, now, timeZone });
      reminders.push({
        kind: "forgotten-timer",
        employeeId: employee.id,
        recipientAccountId: employee.accountId,
        idempotencyKey: buildForgottenTimerIdempotencyKey(entry.id),
        title: message.title,
        body: message.body,
        actionTarget: { type: "forgotten-timer", entryId: entry.id },
      });
    }
  }

  // 3. Podsumowanie tygodnia („podsumowanie tygodnia”)
  if (schedule && localNow.hour >= WEEKLY_SUMMARY_TRIGGER_HOUR) {
    const weekSummary = getWeeklyScheduleSummary(schedule, today, isAbsent);
    if (weekSummary.lastWorkingDay === today && weekSummary.scheduledMinutes > 0) {
      const weekStart = localStartOfDayUtc(weekSummary.weekDates[0]!, timeZone);
      const weekEndExclusive = localStartOfDayUtc(addDaysToLocalDate(weekSummary.weekDates[6]!, 1), timeZone);
      const workedMinutes = computeWorkedMinutesInRange(entries, weekStart, weekEndExclusive, now);
      if (workedMinutes < weekSummary.scheduledMinutes) {
        const missingMinutes = weekSummary.scheduledMinutes - workedMinutes;
        const missingRoundedMinutes = roundMissingMinutesTo15(missingMinutes);
        const isoWeek = getIsoWeek(today);
        const message = buildWeeklySummaryMessage({
          workedMinutes,
          scheduledMinutes: weekSummary.scheduledMinutes,
          missingRoundedMinutes,
        });
        reminders.push({
          kind: "weekly-summary",
          employeeId: employee.id,
          recipientAccountId: employee.accountId,
          idempotencyKey: buildWeeklySummaryIdempotencyKey(employee.id, isoWeek.key),
          title: message.title,
          body: message.body,
          actionTarget: { type: "weekly-summary", isoWeekKey: isoWeek.key },
        });
      }
    }
  }

  return reminders;
}

/**
 * Wylicza minimalny przedział dat potrzebny do jednego zapytania SQL dla całej organizacji
 * (pokrywa maksymalne cofnięcie o 14 dni dla „braku godzin” oraz bieżący tydzień ISO).
 */
export function computeOrganizationQueryWindow(
  now: Date,
  timeZone: string,
): {
  readonly today: LocalDateString;
  readonly fromDate: LocalDateString;
  readonly toDate: LocalDateString;
  readonly fromUtc: Date;
  readonly toUtc: Date;
} {
  const { dateKey: today } = getZonedDateTimeParts(now, timeZone);
  const weekDates = getIsoWeekDates(today);
  const monday = weekDates[0]!;
  const sunday = weekDates[6]!;
  const lookbackStart = addDaysToLocalDate(today, -DEFAULT_MISSING_HOURS_LOOKBACK_DAYS);
  const fromDate = lookbackStart < monday ? lookbackStart : monday;
  const toDate = sunday;

  return {
    today,
    fromDate,
    toDate,
    fromUtc: localStartOfDayUtc(fromDate, timeZone),
    toUtc: localStartOfDayUtc(addDaysToLocalDate(toDate, 1), timeZone),
  };
}
