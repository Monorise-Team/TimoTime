/**
 * Kontrakt API TimoTime (`https://time.monorise.studio/api/v1`): schematy i typy wspólne dla serwera,
 * przeglądarki i telefonu. Format odpowiedzi jak w standardzie API Monorise: `{ data, meta, error }`.
 */
import { z } from "zod";

export const API_PREFIX = "/api/v1";

// ── Odpowiedzi i błędy ──────────────────────────────────────────────────────

export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "CONFLICT",
  "RATE_LIMITED",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details: { field?: string; message: string }[];
}

export interface ApiResponse<T> {
  data: T | null;
  meta: { requestId?: string; [key: string]: unknown };
  error: ApiErrorBody | null;
}

// ── Zalogowana osoba i firma (z MonoriseCore) ───────────────────────────────

export const Me = z.object({
  account: z.object({
    id: z.string(),
    email: z.string(),
  }),
  employee: z.object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    fullName: z.string(),
    jobTitle: z.string().nullable(),
  }),
  organization: z.object({
    id: z.string(),
    name: z.string(),
  }),
});
export type Me = z.infer<typeof Me>;

// ── Rejestracja czasu pracy ─────────────────────────────────────────────────

export const TIME_ENTRY_KINDS = ["WORK", "BREAK", "REMOTE", "BUSINESS_TRIP"] as const;
export const TimeEntryKind = z.enum(TIME_ENTRY_KINDS);
export type TimeEntryKind = z.infer<typeof TimeEntryKind>;

export const TIME_ENTRY_KIND_LABELS: Record<TimeEntryKind, string> = {
  WORK: "Praca",
  BREAK: "Przerwa",
  REMOTE: "Praca zdalna",
  BUSINESS_TRIP: "Wyjście służbowe",
};

export const TimeEntry = z.object({
  id: z.string(),
  organizationId: z.string(),
  accountId: z.string(),
  employeeId: z.string(),
  kind: TimeEntryKind,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TimeEntry = z.infer<typeof TimeEntry>;

export const StartTimeEntryInput = z.object({
  kind: TimeEntryKind,
  note: z
    .string()
    .trim()
    .max(500, "Notatka może mieć najwyżej 500 znaków")
    .transform((value) => (value.length > 0 ? value : undefined))
    .optional(),
});
export type StartTimeEntryInput = z.input<typeof StartTimeEntryInput>;

export const StopTimeEntryInput = z.object({
  note: z
    .string()
    .trim()
    .max(500, "Notatka może mieć najwyżej 500 znaków")
    .transform((value) => (value.length > 0 ? value : undefined))
    .optional(),
});
export type StopTimeEntryInput = z.input<typeof StopTimeEntryInput>;

export const MAX_ENTRIES_RANGE_DAYS = 31;
const MAX_ENTRIES_RANGE_MS = MAX_ENTRIES_RANGE_DAYS * 24 * 60 * 60 * 1000;
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function parseDateParam(value: string, bound: "start" | "end"): Date | null {
  if (DATE_ONLY_REGEX.test(value)) {
    const suffix = bound === "start" ? "T00:00:00.000Z" : "T23:59:59.999Z";
    const parsed = new Date(`${value}${suffix}`);
    if (Number.isNaN(parsed.getTime())) return null;
    // Odrzuć nierealne daty, np. 2026-02-31, które Date przesuwa na marzec.
    if (parsed.toISOString().slice(0, 10) !== value) return null;
    return parsed;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export const TimeEntriesQuery = z
  .object({
    from: z.string().trim().min(1).optional(),
    to: z.string().trim().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const fromDate = value.from ? parseDateParam(value.from, "start") : parseDateParam(today, "start");
    const toDate = value.to ? parseDateParam(value.to, "end") : parseDateParam(today, "end");

    if (value.from && !fromDate) {
      ctx.addIssue({ code: "custom", path: ["from"], message: "Podaj poprawną datę początkową (ISO 8601)" });
    }
    if (value.to && !toDate) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "Podaj poprawną datę końcową (ISO 8601)" });
    }
    if (!fromDate || !toDate) return;

    if (fromDate.getTime() > toDate.getTime()) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "Data końcowa nie może być wcześniejsza niż początkowa" });
      return;
    }
    if (toDate.getTime() - fromDate.getTime() > MAX_ENTRIES_RANGE_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: `Zakres nie może przekraczać ${MAX_ENTRIES_RANGE_DAYS} dni`,
      });
    }
  });
export type TimeEntriesQuery = z.infer<typeof TimeEntriesQuery>;

/** Wylicza granice przedziału `[from, to]` po walidacji `TimeEntriesQuery` (domyślnie dzisiejszy dzień w UTC). */
export function resolveEntriesRange(query: TimeEntriesQuery, now = new Date()): { from: Date; to: Date } {
  const parsed = TimeEntriesQuery.parse(query);
  const today = now.toISOString().slice(0, 10);
  const from = parsed.from ? parseDateParam(parsed.from, "start")! : parseDateParam(today, "start")!;
  const to = parsed.to ? parseDateParam(parsed.to, "end")! : parseDateParam(today, "end")!;
  return { from, to };
}

export const TimeEntriesList = z.object({
  entries: z.array(TimeEntry),
  from: z.string(),
  to: z.string(),
});
export type TimeEntriesList = z.infer<typeof TimeEntriesList>;

export * from "./permissions.js";
