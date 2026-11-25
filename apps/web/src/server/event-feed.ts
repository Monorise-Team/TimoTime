import "server-only";
import {
  coreEvents,
  createEventConsumer,
  createEventFeedPoller,
  type EventConsumer,
  type EventFeedPoller,
  type FeedPage,
} from "@monorise-team/events";
import type { CoreClient } from "@monorise-team/sdk";
import { TIMOTIME_PERMISSIONS } from "@timotime/contracts";
import { config } from "./config";
import { getMachineCoreClient } from "./core";
import { getDb } from "./db";
import { invalidatePermissionCache } from "./permissions";

const CORE_EVENT_CONSUMER_NAME = "timotime";
const CORE_FEED_CURSOR_ID = "core";
const DEFAULT_FEED_LIMIT = 100;

/** Minimalny podzbiór klienta transakcji potrzebny odbiorcy zdarzeń (ułatwia wstrzyknięcie atrapy w testach). */
export interface EventFeedTx {
  processedEvent: {
    findUnique(args: { where: { consumer_eventId: { consumer: string; eventId: string } } }): Promise<unknown | null>;
    create(args: { data: { consumer: string; eventId: string; processedAt: Date } }): Promise<unknown>;
  };
}

/** Minimalny podzbiór klienta bazy danych potrzebny kanałowi zdarzeń Core (bez danych firmowych i bez RLS). */
export interface EventFeedDb {
  $transaction<R>(fn: (tx: EventFeedTx) => Promise<R>): Promise<R>;
  eventFeedCursor: {
    findUnique(args: { where: { id: string } }): Promise<{ sequence: string } | null>;
    upsert(args: {
      where: { id: string };
      create: { id: string; sequence: string };
      update: { sequence: string };
    }): Promise<unknown>;
  };
}

export interface CreateCoreEventPollerOptions {
  db?: EventFeedDb;
  core?: Pick<CoreClient, "listProductEvents">;
  fetchPage?: (after: string | null, limit: number) => Promise<FeedPage>;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

/**
 * Tworzy idempotentnego odbiorcę zdarzeń z MonoriseCore (`@monorise-team/events`).
 * Zapisuje przetworzone identyfikatory w `processed_events`, a po zdarzeniu zmiany uprawnień
 * natychmiast unieważnia pamięć podręczną migawek uprawnień dla firmy i konta.
 */
export function createCoreEventConsumer(db: EventFeedDb): EventConsumer {
  return createEventConsumer<EventFeedTx, typeof coreEvents.definitions>({
    consumer: CORE_EVENT_CONSUMER_NAME,
    catalog: coreEvents,
    transaction: (work) => db.$transaction(work),
    processed: {
      isProcessed: async (tx, consumer, eventId) =>
        Boolean(
          await tx.processedEvent.findUnique({
            where: { consumer_eventId: { consumer, eventId } },
          }),
        ),
      markProcessed: async (tx, consumer, eventId, processedAt) => {
        await tx.processedEvent.create({
          data: { consumer, eventId, processedAt },
        });
      },
    },
    handlers: {
      "organization.permissions.changed": async (event) => {
        invalidatePermissionCache({
          organizationId: event.organizationId ?? undefined,
          accountId: event.resourceId,
        });
      },
    },
  });
}

/**
 * Tworzy poller pobierający numerowany kanał zdarzeń produktu `timotime` z MonoriseCore
 * (`GET /core/v1/products/timotime/events`) i zapisujący kursor w tabeli `event_feed_cursors`.
 */
export function createCoreEventPoller(options: CreateCoreEventPollerOptions = {}): EventFeedPoller {
  const db = options.db ?? getDb();
  const consumer = createCoreEventConsumer(db);
  const fetchPage =
    options.fetchPage ??
    ((after: string | null, limit: number) => {
      const core = options.core ?? getMachineCoreClient();
      return core.listProductEvents({
        path: { productKey: TIMOTIME_PERMISSIONS.product },
        query: { ...(after ? { cursor: after } : {}), limit },
      });
    });

  return createEventFeedPoller({
    consumer,
    cursor: {
      load: async () => {
        const row = await db.eventFeedCursor.findUnique({ where: { id: CORE_FEED_CURSOR_ID } });
        return row?.sequence ?? null;
      },
      save: async (sequence) => {
        await db.eventFeedCursor.upsert({
          where: { id: CORE_FEED_CURSOR_ID },
          create: { id: CORE_FEED_CURSOR_ID, sequence },
          update: { sequence },
        });
      },
    },
    fetchPage,
    limit: DEFAULT_FEED_LIMIT,
    ...(options.intervalMs !== undefined
      ? { intervalMs: options.intervalMs }
      : config.eventFeedIntervalMs > 0
        ? { intervalMs: config.eventFeedIntervalMs }
        : {}),
    onError:
      options.onError ??
      ((error) => {
        console.error("Błąd podczas pobierania zdarzeń z MonoriseCore:", error);
      }),
  });
}

// Strażnik „jeden poller na proces” we wspólnym obiekcie procesu (osobne kopie modułów w Next.js, HMR)
const processGlobal = globalThis as typeof globalThis & { __timotimeStopCoreEventPolling?: (() => void) | null };

/**
 * Uruchamia cykliczne odpytywanie kanału zdarzeń Core raz na proces, gdy `config.eventFeedIntervalMs > 0`.
 * Zwraca funkcję zatrzymującą odpytywanie.
 */
export function startCoreEventPolling(options: CreateCoreEventPollerOptions = {}): () => void {
  if (processGlobal.__timotimeStopCoreEventPolling) {
    return processGlobal.__timotimeStopCoreEventPolling;
  }

  const intervalMs = options.intervalMs ?? config.eventFeedIntervalMs;
  if (intervalMs <= 0) {
    return () => {};
  }

  const poller = createCoreEventPoller({ ...options, intervalMs });
  const stop = poller.start();
  const wrappedStop = () => {
    stop();
    if (processGlobal.__timotimeStopCoreEventPolling === wrappedStop) {
      processGlobal.__timotimeStopCoreEventPolling = null;
    }
  };
  processGlobal.__timotimeStopCoreEventPolling = wrappedStop;
  return wrappedStop;
}
