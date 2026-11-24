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

export interface DayGroup {
  dateKey: string;
  entries: TimeEntry[];
  workMs: number;
  breakMs: number;
}

/** Grupuje wpisy według lokalnego dnia i liczy sumy czasu pracy (bez przerw) oraz przerw. */
export function groupEntriesByDay(entries: readonly TimeEntry[], nowMs: number): DayGroup[] {
  const map = new Map<string, DayGroup>();
  for (const entry of entries) {
    const key = localDateKey(new Date(entry.startedAt));
    let group = map.get(key);
    if (!group) {
      group = { dateKey: key, entries: [], workMs: 0, breakMs: 0 };
      map.set(key, group);
    }
    group.entries.push(entry);
    const ms = entryDurationMs(entry, nowMs);
    if (entry.kind === "BREAK") group.breakMs += ms;
    else group.workMs += ms;
  }
  return [...map.values()].sort((a, b) => b.dateKey.localeCompare(a.dateKey));
}
