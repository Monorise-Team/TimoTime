import "server-only";
import { CoreApiError, type CoreClient } from "@monorise-team/sdk";
import { config } from "./config";
import { getMachineCoreClient } from "./core";
import { CoreMachineTokenError } from "./core-machine";
import type { ReminderActionTarget } from "./reminders-rules";

export type { ReminderActionTarget };

/** Kategoria powiadomień e-mail MonoriseCore z przypomnieniami o czasie pracy TimoTime (ADR-0048). */
export const TIMOTIME_REMINDERS_NOTIFICATION_CATEGORY = "timotime.reminders" as const;

/** Krótki limit czasu dla best-effort zlecenia powiadomienia do MonoriseCore (ms). */
export const DEFAULT_NOTIFICATION_TIMEOUT_MS = 3_000;

/**
 * Buduje link docelowy powiadomienia na originie aplikacji TimoTime (`TIMOTIME_APP_URL`,
 * zgodnym z `uri` klienta OAuth `timotime-web`). Zwraca `null`, gdy adres bazowy albo parametr jest niepoprawny.
 */
export function buildReminderActionUrl(appUrl: string, target: ReminderActionTarget): string | null {
  try {
    const parsed = new URL(appUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    switch (target.type) {
      case "missing-hours": {
        const date = target.date.trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
        return `${parsed.origin}/?date=${encodeURIComponent(date)}#moj-czas`;
      }
      case "forgotten-timer": {
        const entryId = target.entryId.trim();
        if (!entryId) return null;
        return `${parsed.origin}/?entry=${encodeURIComponent(entryId)}#moj-czas`;
      }
      case "weekly-summary": {
        const isoWeekKey = target.isoWeekKey.trim();
        if (!/^\d{4}-W\d{2}$/.test(isoWeekKey)) return null;
        return `${parsed.origin}/?view=week&week=${encodeURIComponent(isoWeekKey)}#moj-czas`;
      }
    }
  } catch {
    return null;
  }
}

function describeNotificationError(error: unknown): string {
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

export interface SendReminderNotificationParams {
  organizationId: string;
  recipientAccountId: string;
  reminderKind: ReminderActionTarget["type"];
  title: string;
  body: string;
  actionTarget: ReminderActionTarget;
  idempotencyKey: string;
}

export interface SendReminderNotificationOptions {
  core?: Pick<CoreClient, "sendNotification">;
  appUrl?: string;
  timeoutMs?: number;
  warn?: (message: string) => void;
}

export type SendReminderNotificationOutcome = "queued" | "skipped" | "failed";

/**
 * Zleca przypomnienie e-mail przez MonoriseCore (`timotime.reminders`, ADR-0048) w trybie
 * best-effort: z krótkim limitem czasu, polityką ponawiania SDK i deterministycznym nagłówkiem
 * `Idempotency-Key`. Błąd Core nigdy nie rzuca wyjątku i nie zapisuje danych osobowych ani tokenów.
 */
export async function sendReminderNotification(
  params: SendReminderNotificationParams,
  options: SendReminderNotificationOptions = {},
): Promise<SendReminderNotificationOutcome> {
  const core = options.core ?? getMachineCoreClient();
  const appUrl = options.appUrl ?? config.appUrl;
  const timeoutMs = options.timeoutMs ?? DEFAULT_NOTIFICATION_TIMEOUT_MS;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  const actionUrl = buildReminderActionUrl(appUrl, params.actionTarget);

  try {
    const result = await core.sendNotification({
      path: { organizationId: params.organizationId },
      body: {
        recipientAccountId: params.recipientAccountId,
        category: TIMOTIME_REMINDERS_NOTIFICATION_CATEGORY,
        title: params.title,
        body: params.body,
        ...(actionUrl ? { actionUrl } : {}),
      },
      headers: { "Idempotency-Key": params.idempotencyKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return result.status === "SKIPPED" ? "skipped" : "queued";
  } catch (error) {
    warn(
      `[timotime.reminders] Nie udało się wysłać przypomnienia (${params.reminderKind}): ${describeNotificationError(error)}.`,
    );
    return "failed";
  }
}
