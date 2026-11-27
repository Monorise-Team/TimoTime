/**
 * Testy odbioru zdarzeń z kanału MonoriseCore (`event-feed.ts`) i konfiguracji interwału odpytywania.
 * Działają w pamięci (atrapa bazy Prisma oraz `createFakeCore` z `@monorise-team/testing`), bez PostgreSQL.
 */
import { organizationPermissionsChanged, uuidv7 } from "@monorise-team/events";
import { createFakeCore } from "@monorise-team/testing";
import { TIMOTIME_PERMISSIONS } from "@timotime/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Caller } from "@/server/auth";
import { config } from "@/server/config";
import { resetMachineCoreTokenCache } from "@/server/core";
import {
  CORE_DIRECTORY_READ_SCOPE,
  CORE_EVENTS_READ_SCOPE,
  CORE_NOTIFICATIONS_SEND_SCOPE,
  CORE_PERMISSIONS_READ_SCOPE,
  CORE_PERMISSIONS_REGISTER_SCOPE,
} from "@/server/core-machine";
import {
  createCoreEventConsumer,
  createCoreEventPoller,
  startCoreEventPolling,
  type EventFeedDb,
  type EventFeedTx,
} from "@/server/event-feed";
import * as permissionsModule from "@/server/permissions";

const FAKE_CORE_URL = "http://core.local.test";
const CLIENT_ID = "timotime-web";
const CLIENT_SECRET = "sekret-klienta-tylko-do-testow";

interface FakeEventDb extends EventFeedDb {
  processedKeys: Set<string>;
  cursors: Map<string, string>;
}

function createFakeEventDb(initialCursor?: string): FakeEventDb {
  const processedKeys = new Set<string>();
  const cursors = new Map<string, string>();
  if (initialCursor !== undefined) {
    cursors.set("core", initialCursor);
  }

  return {
    processedKeys,
    cursors,
    async $transaction<R>(fn: (tx: EventFeedTx) => Promise<R>): Promise<R> {
      // Prosta symulacja atomowości transakcji w pamięci: wycofujemy dopisane wpisy przy błędzie.
      const snapshot = new Set(processedKeys);
      const tx: EventFeedTx = {
        processedEvent: {
          async findUnique({ where }) {
            const key = `${where.consumer_eventId.consumer}:${where.consumer_eventId.eventId}`;
            return processedKeys.has(key) ? { eventId: where.consumer_eventId.eventId } : null;
          },
          async create({ data }) {
            const key = `${data.consumer}:${data.eventId}`;
            if (processedKeys.has(key)) {
              throw new Error(`Duplicate processed event: ${key}`);
            }
            processedKeys.add(key);
            return data;
          },
        },
      };
      try {
        return await fn(tx);
      } catch (error) {
        processedKeys.clear();
        for (const key of snapshot) {
          processedKeys.add(key);
        }
        throw error;
      }
    },
    eventFeedCursor: {
      async findUnique({ where }) {
        const sequence = cursors.get(where.id);
        return sequence !== undefined ? { sequence } : null;
      },
      async upsert({ where, create, update }) {
        const next = cursors.has(where.id) ? update.sequence : create.sequence;
        cursors.set(where.id, next);
        return { id: where.id, sequence: next };
      },
    },
  };
}

function makeCaller(organizationId: string, accountId: string, employeeId: string, authzRevision = 0): Caller {
  return {
    organizationId,
    accountId,
    employeeId,
    session: null,
    token: null,
    context: {
      accountId,
      organizationId,
      employeeId,
      sessionId: "sesja-test",
      authzRevision,
      methods: [],
      clientId: CLIENT_ID,
      scopes: ["openid"],
      expiresAt: new Date(Date.now() + 60_000),
    },
  };
}

function makePermissionsChangedEvent(options: {
  organizationId: string;
  accountId: string;
  authzRevision: number;
  sequence: string;
  id?: string;
}) {
  const envelope = organizationPermissionsChanged.create({
    id: options.id ?? uuidv7(),
    source: "core",
    organizationId: options.organizationId,
    resourceType: "account",
    resourceId: options.accountId,
    resourceVersion: options.authzRevision,
    data: { authzRevision: options.authzRevision },
  });
  return {
    ...envelope,
    organizationId: options.organizationId,
    source: "core" as const,
    sequence: options.sequence,
  };
}

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  permissionsModule.invalidatePermissionCache();
  resetMachineCoreTokenCache();
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("odbiór zdarzeń z kanału Core (event-feed)", () => {
  it("po zdarzeniu organization.permissions.changed unieważnia cache i kolejne zapytanie odświeża migawkę z Core", async () => {
    process.env.CORE_AUTH_URL = FAKE_CORE_URL;
    process.env.CORE_API_URL = FAKE_CORE_URL;

    const fakeCore = await createFakeCore({
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
    vi.spyOn(globalThis, "fetch").mockImplementation(fakeCore.fetch as typeof fetch);

    const acme = fakeCore.organization({ name: "Acme", domain: "acme.test" });
    acme.grantEntitlement("timotime");
    const employeeRole = acme.addRole({
      name: "Pracownik",
      product: "timotime",
      permissions: [TIMOTIME_PERMISSIONS.keys["entries.read_own"], TIMOTIME_PERMISSIONS.keys["entries.write_own"]],
    });

    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: [] });
    const piotr = acme.addEmployee({ firstName: "Piotr", lastName: "Zieliński", products: ["timotime"] });
    acme.assignRole({ accountId: piotr.accountId, roleId: employeeRole.id, scope: { type: "ORGANIZATION" } });

    const annaCaller = makeCaller(acme.id, anna.accountId, anna.employeeId, 0);
    const piotrCaller = makeCaller(acme.id, piotr.accountId, piotr.employeeId, 0);

    // 1. Zapisujemy migawki obu osób w pamięci podręcznej
    await expect(
      permissionsModule.assertTimePermission(annaCaller, TIMOTIME_PERMISSIONS.keys["entries.read_own"]),
    ).rejects.toMatchObject({ status: 403, code: "PRODUCT_ACCESS_REQUIRED" });
    await expect(
      permissionsModule.assertTimePermission(piotrCaller, TIMOTIME_PERMISSIONS.keys["entries.read_own"]),
    ).resolves.toBeDefined();
    expect(fakeCore.calls.permissionSnapshot).toBe(2);

    // 2. W Core Anna dostaje dostęp i rolę, a do TimoTime trafia zdarzenie zmiany uprawnień Anny
    acme.grantAppAccess(anna.accountId, "timotime");
    acme.assignRole({ accountId: anna.accountId, roleId: employeeRole.id, scope: { type: "ORGANIZATION" } });
    const nextRev = acme.bumpAuthzRevision(anna.accountId);

    const db = createFakeEventDb();
    const invalidateSpy = vi.spyOn(permissionsModule, "invalidatePermissionCache");
    const poller = createCoreEventPoller({
      db,
      fetchPage: async () => ({
        items: [
          makePermissionsChangedEvent({
            organizationId: acme.id,
            accountId: anna.accountId,
            authzRevision: nextRev,
            sequence: "1",
          }),
        ],
        nextCursor: null,
      }),
    });

    const summary = await poller.runOnce();
    expect(summary).toMatchObject({ processed: 1, duplicate: 0, ignored: 0, cursor: "1", caughtUp: true });
    expect(invalidateSpy).toHaveBeenCalledWith({ organizationId: acme.id, accountId: anna.accountId });

    // 3. Nawet ze starym tokenem (authz_rev = 0) kolejne wywołanie dla Anny pobiera świeżą migawkę z Core,
    //    natomiast migawka Piotra nadal pochodzi z pamięci podręcznej.
    await expect(
      permissionsModule.assertTimePermission(annaCaller, TIMOTIME_PERMISSIONS.keys["entries.read_own"]),
    ).resolves.toBeDefined();
    expect(fakeCore.calls.permissionSnapshot).toBe(3);

    await expect(
      permissionsModule.assertTimePermission(piotrCaller, TIMOTIME_PERMISSIONS.keys["entries.read_own"]),
    ).resolves.toBeDefined();
    expect(fakeCore.calls.permissionSnapshot).toBe(3);
  });

  it("obsługuje duplikat zdarzenia o tym samym id dokładnie raz", async () => {
    const db = createFakeEventDb();
    const invalidateSpy = vi.spyOn(permissionsModule, "invalidatePermissionCache");
    const duplicateId = uuidv7();
    const organizationId = uuidv7();
    const accountId = uuidv7();

    const poller = createCoreEventPoller({
      db,
      fetchPage: async () => ({
        items: [
          makePermissionsChangedEvent({
            id: duplicateId,
            organizationId,
            accountId,
            authzRevision: 1,
            sequence: "10",
          }),
          makePermissionsChangedEvent({
            id: duplicateId,
            organizationId,
            accountId,
            authzRevision: 1,
            sequence: "11",
          }),
        ],
        nextCursor: null,
      }),
    });

    const summary = await poller.runOnce();
    expect(summary).toMatchObject({ processed: 1, duplicate: 1, cursor: "11" });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(db.processedKeys).toEqual(new Set([`timotime:${duplicateId}`]));
  });

  it("zapisuje kursor i przy kolejnym pobraniu przekazuje go jako cursor", async () => {
    const db = createFakeEventDb();
    const seenCursors: Array<string | null> = [];
    const seenQueries: Array<{ path: { productKey: string }; query?: { cursor?: string; limit?: number } }> = [];

    const poller = createCoreEventPoller({
      db,
      core: {
        async listProductEvents(input) {
          seenQueries.push(input);
          seenCursors.push(input.query?.cursor ?? null);
          if (!input.query?.cursor) {
            return {
              items: [
                makePermissionsChangedEvent({
                  organizationId: uuidv7(),
                  accountId: uuidv7(),
                  authzRevision: 1,
                  sequence: "5",
                }),
              ],
              nextCursor: null,
            };
          }
          return {
            items: [
              makePermissionsChangedEvent({
                organizationId: uuidv7(),
                accountId: uuidv7(),
                authzRevision: 2,
                sequence: "6",
              }),
            ],
            nextCursor: null,
          };
        },
      },
    });

    const first = await poller.runOnce();
    expect(first).toMatchObject({ processed: 1, cursor: "5" });
    expect(db.cursors.get("core")).toBe("5");

    const second = await poller.runOnce();
    expect(second).toMatchObject({ processed: 1, cursor: "6" });
    expect(db.cursors.get("core")).toBe("6");
    expect(seenCursors).toEqual([null, "5"]);
    expect(seenQueries).toEqual([
      { path: { productKey: "timotime" }, query: { limit: 100 } },
      { path: { productKey: "timotime" }, query: { cursor: "5", limit: 100 } },
    ]);
  });

  it("ignoruje nieznany typ zdarzenia i mimo to przesuwa kursor", async () => {
    const db = createFakeEventDb("2");
    const invalidateSpy = vi.spyOn(permissionsModule, "invalidatePermissionCache");

    const poller = createCoreEventPoller({
      db,
      fetchPage: async () => ({
        items: [
          {
            id: uuidv7(),
            type: "organization.unknown.event",
            version: 1,
            source: "core",
            organizationId: uuidv7(),
            resourceType: "account",
            resourceId: uuidv7(),
            resourceVersion: 1,
            occurredAt: new Date().toISOString(),
            data: { extra: true },
            sequence: "3",
          },
        ],
        nextCursor: null,
      }),
    });

    const summary = await poller.runOnce();
    expect(summary).toMatchObject({ processed: 0, ignored: 1, cursor: "3" });
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(db.cursors.get("core")).toBe("3");
    expect(db.processedKeys.size).toBe(0);
  });

  it("nie przesuwa kursora i nie oznacza zdarzenia jako przetworzonego, gdy handler rzuci błąd", async () => {
    const db = createFakeEventDb("1");
    const eventId = uuidv7();
    const organizationId = uuidv7();
    const accountId = uuidv7();

    vi.spyOn(permissionsModule, "invalidatePermissionCache")
      .mockImplementationOnce(() => {
        throw new Error("Błąd unieważnienia cache");
      })
      .mockImplementationOnce(() => {});

    const poller = createCoreEventPoller({
      db,
      fetchPage: async () => ({
        items: [
          makePermissionsChangedEvent({
            id: eventId,
            organizationId,
            accountId,
            authzRevision: 3,
            sequence: "2",
          }),
        ],
        nextCursor: null,
      }),
    });

    await expect(poller.runOnce()).rejects.toThrow("Błąd unieważnienia cache");
    expect(db.cursors.get("core")).toBe("1");
    expect(db.processedKeys.size).toBe(0);

    const retry = await poller.runOnce();
    expect(retry).toMatchObject({ processed: 1, cursor: "2" });
    expect(db.cursors.get("core")).toBe("2");
    expect(db.processedKeys).toEqual(new Set([`timotime:${eventId}`]));
  });

  it("createCoreEventConsumer obsługuje pojedyncze zdarzenie bezpośrednio z pominięciem duplikatu", async () => {
    const db = createFakeEventDb();
    const invalidateSpy = vi.spyOn(permissionsModule, "invalidatePermissionCache");
    const consumer = createCoreEventConsumer(db);
    const envelope = organizationPermissionsChanged.create({
      source: "core",
      organizationId: uuidv7(),
      resourceType: "account",
      resourceId: uuidv7(),
      resourceVersion: 1,
      data: { authzRevision: 1 },
    });

    expect(await consumer.handle(envelope)).toBe("processed");
    expect(await consumer.handle(envelope)).toBe("duplicate");
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it("startCoreEventPolling uruchamia odpytywanie najwyżej raz na proces i nic nie robi przy interwale 0", async () => {
    const fetchPage = vi.fn(async () => ({ items: [], nextCursor: null }));
    const db = createFakeEventDb();

    vi.stubEnv("NODE_ENV", "production");
    delete process.env.TIMOTIME_EVENT_FEED_INTERVAL_MS;
    const noopStop = startCoreEventPolling({ db, fetchPage });
    expect(fetchPage).not.toHaveBeenCalled();
    noopStop();

    vi.stubEnv("TIMOTIME_EVENT_FEED_INTERVAL_MS", "250");
    const stop1 = startCoreEventPolling({ db, fetchPage });
    const stop2 = startCoreEventPolling({ db, fetchPage });
    expect(stop2).toBe(stop1);
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
    stop1();
  });
});

describe("konfiguracja TIMOTIME_EVENT_FEED_INTERVAL_MS", () => {
  it("domyślnie wynosi 5000 w trybie development i 0 w pozostałych środowiskach", () => {
    delete process.env.TIMOTIME_EVENT_FEED_INTERVAL_MS;

    vi.stubEnv("NODE_ENV", "development");
    expect(config.eventFeedIntervalMs).toBe(5000);

    vi.stubEnv("NODE_ENV", "production");
    expect(config.eventFeedIntervalMs).toBe(0);

    vi.stubEnv("NODE_ENV", "test");
    expect(config.eventFeedIntervalMs).toBe(0);
  });

  it("respektuje jawnie ustawioną liczbę całkowitą >= 0 oraz zamienia niepoprawne wartości na 0", () => {
    vi.stubEnv("NODE_ENV", "development");
    process.env.TIMOTIME_EVENT_FEED_INTERVAL_MS = "0";
    expect(config.eventFeedIntervalMs).toBe(0);

    vi.stubEnv("NODE_ENV", "production");
    process.env.TIMOTIME_EVENT_FEED_INTERVAL_MS = "2500";
    expect(config.eventFeedIntervalMs).toBe(2500);

    for (const invalid of ["abc", "-100", "12.5", "100ms", "Infinity"]) {
      process.env.TIMOTIME_EVENT_FEED_INTERVAL_MS = invalid;
      expect(config.eventFeedIntervalMs).toBe(0);
    }
  });
});
