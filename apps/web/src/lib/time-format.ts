import type { TimeEntry } from "@timotime/contracts";

/** Formatuje czas trwania w milisekundach jako czytelny tekst po polsku (np. „2 godz. 15 min”). */
export function formatDuration(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped % 60;
  if (hours > 0) return `${hours} godz. ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${seconds} sek.`;
}

/** Formatuje bieżący licznik w formacie HH:MM:SS. */
export function formatLiveClock(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms / 1000));
  const hours = String(Math.floor(clamped / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((clamped % 3600) / 60)).padStart(2, "0");
  const seconds = String(clamped % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatDayHeading(dateKey: string): string {
  const [year = 1970, month = 1, day = 1] = dateKey.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const formatted = new Intl.DateTimeFormat("pl-PL", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

/** Zwraca lokalny zakres bieżącego dnia w ISO 8601 (od 00:00:00.000 do 23:59:59.999). */
export function todayRange(now = new Date()): { from: string; to: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** Zwraca lokalny zakres bieżącego tygodnia (poniedziałek 00:00:00.000 do niedziela 23:59:59.999). */
export function currentWeekRange(now = new Date()): { from: string; to: string } {
  const dayOfWeek = now.getDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday, 0, 0, 0, 0);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6, 23, 59, 59, 999);
  return { from: monday.toISOString(), to: sunday.toISOString() };
}

export function entryDurationMs(entry: TimeEntry, nowMs: number): number {
  const start = new Date(entry.startedAt).getTime();
  const end = entry.endedAt ? new Date(entry.endedAt).getTime() : nowMs;
  return Math.max(0, end - start);
}

/** Wycinek wpisu przypadający na jeden lokalny dzień kalendarzowy (po podziale o północy). */
export interface DayEntrySlice {
  entry: TimeEntry;
  durationMs: number;
  startedBeforeDay: boolean;
  endedAfterDay: boolean;
}

export interface DayGroup {
  dateKey: string;
  entries: DayEntrySlice[];
  workMs: number;
  breakMs: number;
}

/**
 * Grupuje wpisy według lokalnego dnia kalendarzowego, dzieląc wpisy nocne o lokalnej północy.
 * Gdy podano `range`, liczy tylko dni i fragmenty mieszczące się w tym przedziale (np. dzisiejszy dzień albo tydzień).
 */
export function groupEntriesByDay(
  entries: readonly TimeEntry[],
  nowMs: number,
  range?: { from: string; to: string },
): DayGroup[] {
  const rangeFromMs = range ? new Date(range.from).getTime() : null;
  const rangeToMs = range ? new Date(range.to).getTime() : null;
  const map = new Map<string, DayGroup>();

  for (const entry of entries) {
    const entryStart = new Date(entry.startedAt).getTime();
    const entryEnd = entry.endedAt ? new Date(entry.endedAt).getTime() : Math.max(nowMs, entryStart);
    const effectiveEnd = Math.max(entryStart, entryEnd);

    const clampedStart = rangeFromMs !== null ? Math.max(entryStart, rangeFromMs) : entryStart;
    const clampedEnd = rangeToMs !== null ? Math.min(effectiveEnd, rangeToMs) : effectiveEnd;
    if (clampedEnd < clampedStart) continue;

    const cursor = new Date(clampedStart);
    cursor.setHours(0, 0, 0, 0);

    while (cursor.getTime() <= clampedEnd) {
      const dayStart = cursor.getTime();
      const nextDay = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1, 0, 0, 0, 0);
      const nextDayStart = nextDay.getTime();
      const sliceStart = Math.max(clampedStart, dayStart);
      const sliceEnd = Math.min(clampedEnd, nextDayStart);
      const durationMs = Math.max(0, sliceEnd - sliceStart);

      // Pomijaj pusty początek następnego dnia, gdy wpis kończy się równo o 00:00:00.000
      const endedAtMidnight = sliceStart === dayStart && sliceEnd === dayStart && entryStart < dayStart;
      if (!endedAtMidnight) {
        const key = localDateKey(cursor);
        let group = map.get(key);
        if (!group) {
          group = { dateKey: key, entries: [], workMs: 0, breakMs: 0 };
          map.set(key, group);
        }
        group.entries.push({
          entry,
          durationMs,
          startedBeforeDay: entryStart < dayStart,
          endedAfterDay: effectiveEnd > nextDayStart,
        });
        if (entry.kind === "BREAK") group.breakMs += durationMs;
        else group.workMs += durationMs;
      }

      if (nextDayStart > clampedEnd) break;
      cursor.setTime(nextDayStart);
    }
  }

  return [...map.values()].sort((a, b) => b.dateKey.localeCompare(a.dateKey));
}
