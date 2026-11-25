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
