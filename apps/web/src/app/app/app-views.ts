import { ApiError, type TimeEntry, type TimeEntryKind } from "@timotime/client";
import type { BadgeTone } from "@monorise-team/ui";
import { entryDurationMs, formatDuration, formatTime } from "@/lib/time-format";

export type AppView = "my-time" | "team" | "appearance";

export const VIEW_HASHES: Record<AppView, string> = {
  "my-time": "#moj-czas",
  team: "#zespol",
  appearance: "#wyglad",
};

export const DEFAULT_NO_ACCESS_MESSAGE = "TimoTime nie jest włączony dla Twojego konta. Poproś Ownera firmy o dostęp.";

export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  expired: "Sesja logowania wygasła. Spróbuj zalogować się ponownie.",
  denied: "Logowanie zostało przerwane.",
  unavailable: "Serwer logowania Monorise jest chwilowo niedostępny.",
  failed: "Nie udało się dokończyć logowania. Spróbuj ponownie.",
};

export const KIND_TONES: Record<TimeEntryKind, BadgeTone> = {
  WORK: "success",
  BREAK: "warning",
  REMOTE: "accent",
  BUSINESS_TRIP: "neutral",
};

const START_TOAST_PREFIX: Record<TimeEntryKind, string> = {
  WORK: "Praca rozpoczęta",
  BREAK: "Przerwa rozpoczęta",
  REMOTE: "Praca zdalna rozpoczęta",
  BUSINESS_TRIP: "Wyjście służbowe rozpoczęte",
};

/** Aktualny czas do licznika. Wołane w obsłudze zdarzeń i w efektach, nigdy w renderze. */
export function readClock(): number {
  return Date.now();
}

export function isAccessDeniedError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    (error.code === "PRODUCT_ACCESS_REQUIRED" || error.code === "PERMISSION_DENIED" || error.status === 403)
  );
}

/**
 * Zamienia fragment adresu (`#moj-czas`, `#zespol`, `#wyglad`) na aktywny widok aplikacji.
 * Nieznany fragment albo `#zespol` bez uprawnienia wraca do widoku „Mój czas”.
 */
export function parseViewFromHash(
  hash: string,
  capabilities: { canViewTeam: boolean; canTrackOwn?: boolean },
): AppView {
  const normalized = hash.trim().toLowerCase();
  if (normalized === VIEW_HASHES.appearance) return "appearance";
  if (normalized === VIEW_HASHES.team && capabilities.canViewTeam) return "team";
  if (normalized === VIEW_HASHES["my-time"]) return "my-time";
  if (capabilities.canTrackOwn === false && capabilities.canViewTeam) return "team";
  return "my-time";
}

/** Tytuł powiadomienia po rozpoczęciu nowego wpisu (np. „Praca rozpoczęta o 09:02”). */
export function formatStartToastTitle(entry: Pick<TimeEntry, "kind" | "startedAt">): string {
  return `${START_TOAST_PREFIX[entry.kind]} o ${formatTime(entry.startedAt)}`;
}

/** Tytuł powiadomienia po zakończeniu bieżącego wpisu (np. „Zakończono: 1 godz. 12 min”). */
export function formatStopToastTitle(entry: TimeEntry, nowMs: number): string {
  return `Zakończono: ${formatDuration(entryDurationMs(entry, nowMs))}`;
}

export interface ReminderDeepLink {
  /** Docelowa zakładka listy wpisów („today” albo „week”). */
  readonly tab: "today" | "week";
  /** Wybrana data z przypomnienia (`?date=YYYY-MM-DD`). */
  readonly date: string | null;
  /** Identyfikator wpisu z przypomnienia o stoperze (`?entry=<id>`). */
  readonly entryId: string | null;
  /** Tydzień ISO z podsumowania tygodnia (`?week=YYYY-Www`). */
  readonly week: string | null;
}

const VALID_DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const VALID_ISO_WEEK_KEY = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/;

function parseValidDateKey(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const match = VALID_DATE_KEY.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) {
    return null;
  }
  return trimmed;
}

/**
 * Odczytuje parametry głębokiego linku z przypomnień e-mail (`?date=YYYY-MM-DD`, `?entry=<id>`,
 * `?view=week&week=YYYY-Www`). Niepoprawne wartości są bezpiecznie ignorowane.
 */
export function parseReminderDeepLink(search: string): ReminderDeepLink {
  const params = new URLSearchParams(search);
  const date = parseValidDateKey(params.get("date"));
  const rawEntry = params.get("entry")?.trim() ?? "";
  const entryId = rawEntry.length > 0 && rawEntry.length <= 128 ? rawEntry : null;
  const rawWeek = params.get("week")?.trim() ?? "";
  const week = VALID_ISO_WEEK_KEY.test(rawWeek) ? rawWeek : null;
  const view = params.get("view")?.trim().toLowerCase();
  const tab: "today" | "week" = view === "week" || week !== null ? "week" : "today";
  return { tab, date, entryId, week };
}

/**
 * Buduje adres `/api/auth/sign-in?returnTo=...` zachowujący bezpieczne parametry linku z e-maila
 * (z pominięciem `auth_error` i blokadą przekierowań na obce domeny).
 */
export function buildSignInHref(location: { pathname: string; search: string; hash: string }): string {
  const pathname = location.pathname.startsWith("/") && !location.pathname.startsWith("//") ? location.pathname : "/";
  const params = new URLSearchParams(location.search);
  params.delete("auth_error");
  const cleanSearch = params.toString();
  const hash = location.hash.startsWith("#") ? location.hash : "";
  const returnTo = `${pathname}${cleanSearch ? `?${cleanSearch}` : ""}${hash}`;
  return `/api/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`;
}
