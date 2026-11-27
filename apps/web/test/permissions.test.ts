/**
 * Testy uprawnień z migawki Core, odświeżania cache po `authz_rev` oraz logiki widoku zespołu
 * (zakresy UNIT/ORGANIZATION/NONE/RESOURCE, stronicowanie i dzielenie na paczki po 100) bez bazy PostgreSQL
 * i bez gniazd TCP (atrapa `createFakeCore` z `@monorise-team/testing` podpięta pod `globalThis.fetch`).
 */
import { createFakeCore, type FakeCore, type FakeOrganizationBuilder } from "@monorise-team/testing";
import { TIMOTIME_PERMISSIONS } from "@timotime/contracts";
import * as dbModule from "@timotime/db";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, route } from "@/server/api";
import type { Caller } from "@/server/auth";
import { resetMachineCoreTokenCache } from "@/server/core";
import {
  CORE_DIRECTORY_READ_SCOPE,
  CORE_EVENTS_READ_SCOPE,
  CORE_NOTIFICATIONS_SEND_SCOPE,
  CORE_PERMISSIONS_READ_SCOPE,
  CORE_PERMISSIONS_REGISTER_SCOPE,
} from "@/server/core-machine";
import * as serverDb from "@/server/db";
import {
  assertTeamReadScope,
  assertTimePermission,
  getUserCapabilities,
  invalidatePermissionCache,
  PRODUCT_ACCESS_REQUIRED_MESSAGE,
} from "@/server/permissions";
import { getTeamCurrentEntries, listTeamTimeEntries } from "@/server/team-entries";

const FAKE_CORE_URL = "http://core.local.test";
const CLIENT_ID = "timotime-web";
const CLIENT_SECRET = "sekret-klienta-tylko-do-testow";

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

function makeDbRow(
  organizationId: string,
  accountId: string,
  employeeId: string,
  endedAt: Date | null = null,
): dbModule.TimeEntryModel {
  const startedAt = new Date("2026-11-24T08:00:00.000Z");
  return {
    id: dbModule.uuidv7(),
    organizationId,
    accountId,
    employeeId,
    kind: "WORK",
    startedAt,
    endedAt,
    note: null,
    createdAt: startedAt,
    updatedAt: startedAt,
  };
}

let fakeCore: FakeCore;
let acme: FakeOrganizationBuilder;
let unitKrakowId: string;
let unitSalesId: string;
let unitKrakowAId: string;
let unitWarszawaId: string;
let employeeRoleId: string;
let managerReadRoleId: string;

/**
 * Cienki adapter wokół `fakeCore.fetch`:
 * - wymusza mniejszy `limit` w zapytaniach do katalogu (test wielostronicowego stronicowania kursorowego),
 * - zapisuje zapytane identyfikatory pracowników,
 * - pozwala zasymulować błąd 500 lub sieciowy dla `/permission-snapshot`.
 */
let directoryMaxLimit: number | null = null;
let snapshotFault: "none" | "server-error" | "network-error" = "none";
let employeeBatches: string[][] = [];

async function coreFetchAdapter(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(rawUrl);

  if (url.pathname === "/core/v1/products/timotime/permission-snapshot") {
    if (snapshotFault === "network-error") {
      throw new TypeError("connect ECONNREFUSED");
    }
    if (snapshotFault === "server-error") {
      return new Response(
        JSON.stringify({
          data: null,
          meta: { requestId: "req_500" },
          error: { code: "INTERNAL_ERROR", message: "Core failure", details: [] },
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  if (url.pathname === "/core/v1/products/timotime/directory/employees") {
    employeeBatches.push(url.searchParams.getAll("employeeId"));
  }

  if (
    directoryMaxLimit !== null &&
    (url.pathname === "/core/v1/products/timotime/directory/unit-members" ||
      url.pathname === "/core/v1/products/timotime/directory/employees")
  ) {
    const requested = Number(url.searchParams.get("limit") ?? "50");
    url.searchParams.set("limit", String(Math.min(requested, directoryMaxLimit)));
    return fakeCore.fetch(url, init);
  }

  return fakeCore.fetch(input, init);
}

beforeEach(async () => {
  process.env.CORE_AUTH_URL = FAKE_CORE_URL;
  process.env.CORE_API_URL = FAKE_CORE_URL;
  directoryMaxLimit = null;
  snapshotFault = "none";
  employeeBatches = [];

  fakeCore = await createFakeCore({
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

  acme = fakeCore.organization({ name: "Acme", domain: "acme.test" });
  acme.grantEntitlement("timotime");

  const krakow = acme.addUnit({ name: "Oddział Kraków", type: "BRANCH" });
  const sales = acme.addUnit({ name: "Dział Sprzedaży", type: "DEPARTMENT", parentId: krakow.id });
  const krakowA = acme.addUnit({ name: "Zespół Kraków A", type: "TEAM", parentId: sales.id });
  const warszawa = acme.addUnit({ name: "Oddział Warszawa", type: "BRANCH" });
  unitKrakowId = krakow.id;
  unitSalesId = sales.id;
  unitKrakowAId = krakowA.id;
  unitWarszawaId = warszawa.id;

  employeeRoleId = acme.addRole({
    name: "Pracownik",
    product: "timotime",
    permissions: [TIMOTIME_PERMISSIONS.keys["entries.read_own"], TIMOTIME_PERMISSIONS.keys["entries.write_own"]],
  }).id;
  managerReadRoleId = acme.addRole({
    name: "Kierownik",
    product: "timotime",
    permissions: [TIMOTIME_PERMISSIONS.keys["entries.read"]],
  }).id;

  invalidatePermissionCache();
  resetMachineCoreTokenCache();
  vi.spyOn(globalThis, "fetch").mockImplementation(coreFetchAdapter as typeof fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("uprawnienia z migawki MonoriseCore i pamięć podręczna", () => {
  it("odmawia dostępu (403 PRODUCT_ACCESS_REQUIRED), gdy migawka nie zawiera produktu timotime, nawet dla Ownera", async () => {
    const noPlanOrg = fakeCore.organization({ name: "BezPlanu", domain: "bezplanu.test" });
    const owner = noPlanOrg.addEmployee({ firstName: "Anna", lastName: "Nowak", isOwner: true });

    const caller = makeCaller(noPlanOrg.id, owner.accountId, owner.employeeId);
    const error = await assertTimePermission(caller, TIMOTIME_PERMISSIONS.keys["entries.read_own"]).catch((e) => e);
    expect(error).toBeInstanceOf(ApiFailure);
    expect((error as ApiFailure).status).toBe(403);
    expect((error as ApiFailure).code).toBe("PRODUCT_ACCESS_REQUIRED");
    expect((error as ApiFailure).message).toBe(PRODUCT_ACCESS_REQUIRED_MESSAGE);

    expect(await getUserCapabilities(caller)).toEqual({ trackOwnTime: false, viewTeam: false });
  });

  it("przepuszcza pracownika z read_own/write_own i odmawia widoku zespołu (NONE -> 403 PERMISSION_DENIED)", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["timotime"] });
    acme.assignRole({ accountId: anna.accountId, roleId: employeeRoleId, scope: { type: "ORGANIZATION" } });

    const caller = makeCaller(acme.id, anna.accountId, anna.employeeId);
    await expect(assertTimePermission(caller, TIMOTIME_PERMISSIONS.keys["entries.read_own"])).resolves.toBeDefined();
    await expect(assertTimePermission(caller, TIMOTIME_PERMISSIONS.keys["entries.write_own"])).resolves.toBeDefined();
    expect(await getUserCapabilities(caller)).toEqual({ trackOwnTime: true, viewTeam: false });

    const teamError = await assertTeamReadScope(caller).catch((e) => e);
    expect(teamError).toBeInstanceOf(ApiFailure);
    expect((teamError as ApiFailure).status).toBe(403);
    expect((teamError as ApiFailure).code).toBe("PERMISSION_DENIED");
    // Wszystkie cztery wywołania korzystały z jednej migawki w cache i jednego tokenu maszynowego
    expect(fakeCore.calls.permissionSnapshot).toBe(1);
    expect(fakeCore.calls.token).toBe(1);
  });

  it("natychmiast odświeża migawkę w pamięci podręcznej, gdy rośnie authz_rev w tokenie", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: [] });

    await expect(
      assertTimePermission(
        makeCaller(acme.id, anna.accountId, anna.employeeId, 0),
        TIMOTIME_PERMISSIONS.keys["entries.read_own"],
      ),
    ).rejects.toMatchObject({ status: 403, code: "PRODUCT_ACCESS_REQUIRED" });
    expect(fakeCore.calls.permissionSnapshot).toBe(1);

    // Owner włącza TimoTime i nadaje rolę Pracownik (authz_rev rośnie do 1)
    acme.grantAppAccess(anna.accountId, "timotime");
    acme.assignRole({ accountId: anna.accountId, roleId: employeeRoleId, scope: { type: "ORGANIZATION" } });
    const nextRev = acme.bumpAuthzRevision(anna.accountId);
    expect(nextRev).toBe(1);

    // Stary token (authz_rev = 0) nadal dostaje wynik z cache
    await expect(
      assertTimePermission(
        makeCaller(acme.id, anna.accountId, anna.employeeId, 0),
        TIMOTIME_PERMISSIONS.keys["entries.read_own"],
      ),
    ).rejects.toMatchObject({ status: 403, code: "PRODUCT_ACCESS_REQUIRED" });
    expect(fakeCore.calls.permissionSnapshot).toBe(1);

    // Nowy token (authz_rev = 1) od razu odświeża migawkę bez czekania 5 minut
    await expect(
      assertTimePermission(
        makeCaller(acme.id, anna.accountId, anna.employeeId, nextRev),
        TIMOTIME_PERMISSIONS.keys["entries.read_own"],
      ),
    ).resolves.toBeDefined();
    expect(fakeCore.calls.permissionSnapshot).toBe(2);
  });

  it("zwraca 503 przez route(), gdy Core API jest niedostępne lub zwraca 500", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["timotime"] });
    const handler = route(async () => {
      await assertTimePermission(
        makeCaller(acme.id, anna.accountId, anna.employeeId),
        TIMOTIME_PERMISSIONS.keys["entries.read_own"],
      );
      return { ok: true };
    });

    snapshotFault = "server-error";
    const req1 = new NextRequest("http://time.localhost:3300/api/v1/time/current");
    const res1 = await handler(req1, { params: Promise.resolve({}) });
    expect(res1.status).toBe(503);

    snapshotFault = "network-error";
    const req2 = new NextRequest("http://time.localhost:3300/api/v1/time/current");
    const res2 = await handler(req2, { params: Promise.resolve({}) });
    expect(res2.status).toBe(503);
  });
});

describe("widok zespołu (kierownik): zakresy, stronicowanie i paczki po 100", () => {
  function mockTeamDb(allRows: dbModule.TimeEntryModel[]) {
    const capturedScopes: dbModule.TeamScope[] = [];
    vi.spyOn(serverDb, "getDb").mockReturnValue({} as dbModule.PrismaClient);
    vi.spyOn(dbModule, "withTeamScope").mockImplementation(async (_db, _actor, scope, fn) => {
      capturedScopes.push(scope);
      const visible =
        scope.type === "ALL" ? allRows : allRows.filter((row) => scope.employeeIds.includes(row.employeeId));
      const fakeTx = {
        timeEntry: {
          findMany: async () => visible,
        },
      } as unknown as dbModule.Tx;
      return fn(fakeTx);
    });
    return { capturedScopes };
  }

  it("Jan z zakresem UNIT Kraków widzi Annę (podjednostka Krakowa) i Marka, a nie Piotra (Warszawa), ze stronicowaniem katalogu", async () => {
    directoryMaxLimit = 1;

    const anna = acme.addEmployee({
      firstName: "Anna",
      lastName: "Nowak",
      unitIds: [unitKrakowAId],
      products: ["timotime"],
    });
    const marek = acme.addEmployee({
      firstName: "Marek",
      lastName: "Kowalski",
      unitIds: [unitSalesId],
      products: ["timotime"],
    });
    const piotr = acme.addEmployee({
      firstName: "Piotr",
      lastName: "Zieliński",
      unitIds: [unitWarszawaId],
      products: ["timotime"],
    });
    const jan = acme.addEmployee({ firstName: "Jan", lastName: "Wiśniewski", products: ["timotime"] });
    acme.assignRole({
      accountId: jan.accountId,
      roleId: managerReadRoleId,
      scope: { type: "UNIT", unitId: unitKrakowId },
    });

    const annaRow = makeDbRow(acme.id, anna.accountId, anna.employeeId, null);
    const marekRow = makeDbRow(acme.id, marek.accountId, marek.employeeId, null);
    const piotrRow = makeDbRow(acme.id, piotr.accountId, piotr.employeeId, null);
    const { capturedScopes } = mockTeamDb([annaRow, marekRow, piotrRow]);

    const result = await getTeamCurrentEntries(makeCaller(acme.id, jan.accountId, jan.employeeId));
    expect(capturedScopes).toHaveLength(1);
    expect(capturedScopes[0]).toEqual({
      type: "EMPLOYEES",
      employeeIds: expect.arrayContaining([anna.employeeId, marek.employeeId]),
    });
    expect(result.entries.map((e) => e.employee)).toEqual([
      { id: anna.employeeId, firstName: "Anna", lastName: "Nowak" },
      { id: marek.employeeId, firstName: "Marek", lastName: "Kowalski" },
    ]);
    // Stronicowanie po 1 elemencie wymusiło wiele zapytań z kursorem w atrapie Core
    expect(fakeCore.calls.directoryUnitMembers).toBeGreaterThanOrEqual(2);
    expect(fakeCore.calls.directoryEmployees).toBeGreaterThanOrEqual(2);
    // Katalog pracowników został zapytany wyłącznie o Annę i Marka, bez Piotra
    for (const ids of employeeBatches) {
      expect(ids).not.toContain(piotr.employeeId);
    }
  });

  it("zakres ORGANIZATION widzi wszystkich pracowników firmy bez wywoływania directory/unit-members", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["timotime"] });
    const piotr = acme.addEmployee({ firstName: "Piotr", lastName: "Zieliński", products: ["timotime"] });
    const owner = acme.addEmployee({ firstName: "Jan", lastName: "Wiśniewski", isOwner: true });

    const { capturedScopes } = mockTeamDb([
      makeDbRow(acme.id, anna.accountId, anna.employeeId, new Date("2026-11-24T12:00:00.000Z")),
      makeDbRow(acme.id, piotr.accountId, piotr.employeeId, new Date("2026-11-24T12:00:00.000Z")),
    ]);

    const result = await listTeamTimeEntries(makeCaller(acme.id, owner.accountId, owner.employeeId), {
      from: "2026-11-24",
      to: "2026-11-24",
    });
    expect(capturedScopes).toEqual([{ type: "ALL" }]);
    expect(fakeCore.calls.directoryUnitMembers).toBe(0);
    expect(result.entries.map((e) => e.employee.firstName)).toEqual(["Anna", "Piotr"]);
  });

  it("pomija nadania typu RESOURCE bez pytania o wszystkie jednostki firmy", async () => {
    const anna = acme.addEmployee({ firstName: "Anna", lastName: "Nowak", products: ["timotime"] });
    const jan = acme.addEmployee({ firstName: "Jan", lastName: "Wiśniewski", products: ["timotime"] });
    acme.assignRole({
      accountId: jan.accountId,
      roleId: managerReadRoleId,
      scope: { type: "RESOURCE", resourceId: "project-1" },
    });

    const { capturedScopes } = mockTeamDb([makeDbRow(acme.id, anna.accountId, anna.employeeId, null)]);
    const result = await getTeamCurrentEntries(makeCaller(acme.id, jan.accountId, jan.employeeId));
    expect(result.entries).toEqual([]);
    expect(fakeCore.calls.directoryUnitMembers).toBe(0);
    expect(capturedScopes).toEqual([]);
  });

  it("dzieli zapytania do directory/employees na paczki po 100 identyfikatorów", async () => {
    const owner = acme.addEmployee({ firstName: "Jan", lastName: "Wiśniewski", isOwner: true });

    const rows: dbModule.TimeEntryModel[] = [];
    for (let i = 0; i < 125; i += 1) {
      const emp = acme.addEmployee({ firstName: `Imie${i}`, lastName: `Nazwisko${i}` });
      rows.push(makeDbRow(acme.id, emp.accountId, emp.employeeId, null));
    }

    mockTeamDb(rows);
    const result = await getTeamCurrentEntries(makeCaller(acme.id, owner.accountId, owner.employeeId));
    expect(result.entries).toHaveLength(125);
    expect(employeeBatches.map((batch) => batch.length)).toEqual([100, 25]);
    expect(fakeCore.calls.directoryEmployees).toBe(2);
  });
});
