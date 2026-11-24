/**
 * Testy uprawnień z migawki Core, odświeżania cache po `authz_rev` oraz logiki widoku zespołu
 * (zakresy UNIT/ORGANIZATION/NONE/RESOURCE, stronicowanie i dzielenie na paczki po 100) bez bazy PostgreSQL
 * i bez gniazd TCP (wirtualny `fetch` dla Core Auth i Core API).
 */
import { randomUUID } from "node:crypto";
import type { PermissionSnapshot } from "@monorise-team/permissions";
import { TIMOTIME_PERMISSIONS } from "@timotime/contracts";
import * as dbModule from "@timotime/db";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, route } from "@/server/api";
import type { Caller } from "@/server/auth";
import { resetMachineCoreTokenCache } from "@/server/core";
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
const ACME = randomUUID();
const UNIT_KRAKOW = randomUUID();
const UNIT_SALES = randomUUID();
const UNIT_KRAKOW_A = randomUUID();
const UNIT_WARSZAWA = randomUUID();

const ACME_UNITS = [
  { id: UNIT_KRAKOW, parentId: null },
  { id: UNIT_SALES, parentId: UNIT_KRAKOW },
  { id: UNIT_KRAKOW_A, parentId: UNIT_SALES },
  { id: UNIT_WARSZAWA, parentId: null },
];

const JAN_ACC = randomUUID();
const JAN_EMP = randomUUID();
const ANNA_ACC = randomUUID();
const ANNA_EMP = randomUUID();
const MAREK_ACC = randomUUID();
const MAREK_EMP = randomUUID();
const PIOTR_ACC = randomUUID();
const PIOTR_EMP = randomUUID();

function makeCaller(accountId: string, employeeId: string, authzRevision = 0): Caller {
  return {
    organizationId: ACME,
    accountId,
    employeeId,
    session: null,
    token: null,
    context: {
      accountId,
      organizationId: ACME,
      employeeId,
      sessionId: "sesja-test",
      authzRevision,
      methods: [],
      clientId: "timotime-web",
      scopes: ["openid"],
      expiresAt: new Date(Date.now() + 60_000),
    },
  };
}

function makeDbRow(accountId: string, employeeId: string, endedAt: Date | null = null): dbModule.TimeEntryModel {
  const startedAt = new Date("2026-11-24T08:00:00.000Z");
  return {
    id: dbModule.uuidv7(),
    organizationId: ACME,
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let tokenRequests = 0;
let snapshotRequests = 0;
let snapshotMode: "ok" | "server-error" | "network-error" = "ok";
let unitMemberRequests: string[] = [];
let employeeRequests: string[][] = [];
let unitMembersPageSize = 100;
let employeesPageSize = 100;
let snapshotsByAccount = new Map<string, PermissionSnapshot>();
let directoryMembers: { unitId: string; employeeId: string; accountId: string | null; role: "MEMBER" | "LEADER" }[] =
  [];
let directoryEmployees: {
  id: string;
  accountId: string | null;
  firstName: string;
  lastName: string;
  status: "ACTIVE";
}[] = [];

function fakeCoreFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(rawUrl);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);

  if (url.pathname === "/api/auth/oauth2/token" && method === "POST") {
    tokenRequests += 1;
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("scope")).toBe("core:permissions.read core:directory.read");
    return Promise.resolve(
      jsonResponse({ access_token: `mach-token-${tokenRequests}`, expires_in: 300, token_type: "Bearer" }),
    );
  }

  if (url.pathname === "/core/v1/products/timotime/permission-snapshot" && method === "GET") {
    snapshotRequests += 1;
    expect(headers.get("authorization")).toMatch(/^Bearer mach-token-/);
    if (snapshotMode === "network-error") {
      return Promise.reject(new TypeError("connect ECONNREFUSED"));
    }
    if (snapshotMode === "server-error") {
      return Promise.resolve(
        jsonResponse(
          {
            data: null,
            meta: { requestId: "req_500" },
            error: { code: "INTERNAL", message: "Core failure", details: [] },
          },
          500,
        ),
      );
    }
    const accountId = url.searchParams.get("accountId") ?? "";
    const snapshot = snapshotsByAccount.get(accountId);
    if (!snapshot) {
      return Promise.resolve(
        jsonResponse(
          {
            data: null,
            meta: { requestId: "req_404" },
            error: { code: "NOT_FOUND", message: "Not found", details: [] },
          },
          404,
        ),
      );
    }
    return Promise.resolve(jsonResponse({ data: snapshot, meta: { requestId: "req_snap" }, error: null }));
  }

  if (url.pathname === "/core/v1/products/timotime/directory/unit-members" && method === "GET") {
    expect(headers.get("authorization")).toMatch(/^Bearer mach-token-/);
    const unitIds = url.searchParams.getAll("unitId");
    unitMemberRequests.push(url.search);
    const filtered = unitIds.length > 0 ? directoryMembers.filter((m) => unitIds.includes(m.unitId)) : directoryMembers;
    const startIndex = Number(url.searchParams.get("cursor") ?? "0");
    const pageLimit = Math.min(Number(url.searchParams.get("limit") ?? "50"), unitMembersPageSize);
    const items = filtered.slice(startIndex, startIndex + pageLimit);
    const nextCursor = startIndex + pageLimit < filtered.length ? String(startIndex + pageLimit) : null;
    return Promise.resolve(jsonResponse({ data: items, meta: { requestId: "req_um", nextCursor }, error: null }));
  }

  if (url.pathname === "/core/v1/products/timotime/directory/employees" && method === "GET") {
    expect(headers.get("authorization")).toMatch(/^Bearer mach-token-/);
    const employeeIds = url.searchParams.getAll("employeeId");
    employeeRequests.push(employeeIds);
    const filtered =
      employeeIds.length > 0 ? directoryEmployees.filter((e) => employeeIds.includes(e.id)) : directoryEmployees;
    const startIndex = Number(url.searchParams.get("cursor") ?? "0");
    const pageLimit = Math.min(Number(url.searchParams.get("limit") ?? "50"), employeesPageSize);
    const items = filtered.slice(startIndex, startIndex + pageLimit);
    const nextCursor = startIndex + pageLimit < filtered.length ? String(startIndex + pageLimit) : null;
    return Promise.resolve(jsonResponse({ data: items, meta: { requestId: "req_emp", nextCursor }, error: null }));
  }

  return Promise.resolve(
    jsonResponse(
      { data: null, meta: { requestId: "req_404" }, error: { code: "NOT_FOUND", message: "Not found", details: [] } },
      404,
    ),
  );
}

beforeEach(() => {
  process.env.CORE_AUTH_URL = FAKE_CORE_URL;
  process.env.CORE_API_URL = FAKE_CORE_URL;
  tokenRequests = 0;
  snapshotRequests = 0;
  snapshotMode = "ok";
  unitMemberRequests = [];
  employeeRequests = [];
  unitMembersPageSize = 100;
  employeesPageSize = 100;
  snapshotsByAccount = new Map();
  directoryMembers = [
    { unitId: UNIT_KRAKOW_A, employeeId: ANNA_EMP, accountId: ANNA_ACC, role: "MEMBER" },
    { unitId: UNIT_SALES, employeeId: MAREK_EMP, accountId: MAREK_ACC, role: "MEMBER" },
    { unitId: UNIT_WARSZAWA, employeeId: PIOTR_EMP, accountId: PIOTR_ACC, role: "MEMBER" },
  ];
  directoryEmployees = [
    { id: ANNA_EMP, accountId: ANNA_ACC, firstName: "Anna", lastName: "Nowak", status: "ACTIVE" },
    { id: MAREK_EMP, accountId: MAREK_ACC, firstName: "Marek", lastName: "Kowalski", status: "ACTIVE" },
    { id: PIOTR_EMP, accountId: PIOTR_ACC, firstName: "Piotr", lastName: "Zieliński", status: "ACTIVE" },
    { id: JAN_EMP, accountId: JAN_ACC, firstName: "Jan", lastName: "Wiśniewski", status: "ACTIVE" },
  ];
  invalidatePermissionCache();
  resetMachineCoreTokenCache();
  vi.spyOn(globalThis, "fetch").mockImplementation(fakeCoreFetch as typeof fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("uprawnienia z migawki MonoriseCore i pamięć podręczna", () => {
  it("odmawia dostępu (403), gdy migawka nie zawiera produktu timotime, nawet dla Ownera", async () => {
    snapshotsByAccount.set(ANNA_ACC, {
      accountId: ANNA_ACC,
      organizationId: ACME,
      authzRevision: 0,
      isOwner: true,
      products: [],
      grants: [],
      units: ACME_UNITS,
    });

    const caller = makeCaller(ANNA_ACC, ANNA_EMP);
    const error = await assertTimePermission(caller, TIMOTIME_PERMISSIONS.keys["entries.read_own"]).catch((e) => e);
    expect(error).toBeInstanceOf(ApiFailure);
    expect((error as ApiFailure).status).toBe(403);
    expect((error as ApiFailure).code).toBe("PERMISSION_DENIED");
    expect((error as ApiFailure).message).toBe(PRODUCT_ACCESS_REQUIRED_MESSAGE);

    expect(await getUserCapabilities(caller)).toEqual({ trackOwnTime: false, viewTeam: false });
  });

  it("przepuszcza pracownika z read_own/write_own i odmawia widoku zespołu (NONE -> 403)", async () => {
    snapshotsByAccount.set(ANNA_ACC, {
      accountId: ANNA_ACC,
      organizationId: ACME,
      authzRevision: 0,
      isOwner: false,
      products: ["timotime"],
      grants: [
        { permission: "timotime.entries.read_own", scope: { type: "ORGANIZATION" } },
        { permission: "timotime.entries.write_own", scope: { type: "ORGANIZATION" } },
      ],
      units: ACME_UNITS,
    });

    const caller = makeCaller(ANNA_ACC, ANNA_EMP);
    await expect(assertTimePermission(caller, TIMOTIME_PERMISSIONS.keys["entries.read_own"])).resolves.toBeDefined();
    await expect(assertTimePermission(caller, TIMOTIME_PERMISSIONS.keys["entries.write_own"])).resolves.toBeDefined();
    expect(await getUserCapabilities(caller)).toEqual({ trackOwnTime: true, viewTeam: false });

    const teamError = await assertTeamReadScope(caller).catch((e) => e);
    expect(teamError).toBeInstanceOf(ApiFailure);
    expect((teamError as ApiFailure).status).toBe(403);
    // Wszystkie cztery wywołania korzystały z jednej migawki w cache i jednego tokenu maszynowego
    expect(snapshotRequests).toBe(1);
    expect(tokenRequests).toBe(1);
  });

  it("natychmiast odświeża migawkę w pamięci podręcznej, gdy rośnie authz_rev w tokenie", async () => {
    snapshotsByAccount.set(ANNA_ACC, {
      accountId: ANNA_ACC,
      organizationId: ACME,
      authzRevision: 0,
      isOwner: false,
      products: [],
      grants: [],
      units: ACME_UNITS,
    });

    await expect(
      assertTimePermission(makeCaller(ANNA_ACC, ANNA_EMP, 0), TIMOTIME_PERMISSIONS.keys["entries.read_own"]),
    ).rejects.toMatchObject({ status: 403 });
    expect(snapshotRequests).toBe(1);

    // Owner włącza TimoTime i nadaje rolę Pracownik (authz_rev rośnie do 1)
    snapshotsByAccount.set(ANNA_ACC, {
      accountId: ANNA_ACC,
      organizationId: ACME,
      authzRevision: 1,
      isOwner: false,
      products: ["timotime"],
      grants: [
        { permission: "timotime.entries.read_own", scope: { type: "ORGANIZATION" } },
        { permission: "timotime.entries.write_own", scope: { type: "ORGANIZATION" } },
      ],
      units: ACME_UNITS,
    });

    // Stary token (authz_rev = 0) nadal dostaje wynik z cache
    await expect(
      assertTimePermission(makeCaller(ANNA_ACC, ANNA_EMP, 0), TIMOTIME_PERMISSIONS.keys["entries.read_own"]),
    ).rejects.toMatchObject({ status: 403 });
    expect(snapshotRequests).toBe(1);

    // Nowy token (authz_rev = 1) od razu odświeża migawkę bez czekania 5 minut
    await expect(
      assertTimePermission(makeCaller(ANNA_ACC, ANNA_EMP, 1), TIMOTIME_PERMISSIONS.keys["entries.read_own"]),
    ).resolves.toBeDefined();
    expect(snapshotRequests).toBe(2);
  });

  it("zwraca 503 przez route(), gdy Core API jest niedostępne lub zwraca 500", async () => {
    const handler = route(async () => {
      await assertTimePermission(makeCaller(ANNA_ACC, ANNA_EMP), TIMOTIME_PERMISSIONS.keys["entries.read_own"]);
      return { ok: true };
    });

    snapshotMode = "server-error";
    const req1 = new NextRequest("http://time.localhost:3300/api/v1/time/current");
    const res1 = await handler(req1, { params: Promise.resolve({}) });
    expect(res1.status).toBe(503);

    snapshotMode = "network-error";
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
    unitMembersPageSize = 1;
    employeesPageSize = 1;

    snapshotsByAccount.set(JAN_ACC, {
      accountId: JAN_ACC,
      organizationId: ACME,
      authzRevision: 0,
      isOwner: false,
      products: ["timotime"],
      grants: [
        {
          permission: "timotime.entries.read",
          scope: { type: "UNIT", unitId: UNIT_KRAKOW },
        },
      ],
      units: ACME_UNITS,
    });

    const annaRow = makeDbRow(ANNA_ACC, ANNA_EMP, null);
    const marekRow = makeDbRow(MAREK_ACC, MAREK_EMP, null);
    const piotrRow = makeDbRow(PIOTR_ACC, PIOTR_EMP, null);
    const { capturedScopes } = mockTeamDb([annaRow, marekRow, piotrRow]);

    const result = await getTeamCurrentEntries(makeCaller(JAN_ACC, JAN_EMP));
    expect(capturedScopes).toHaveLength(1);
    expect(capturedScopes[0]).toEqual({
      type: "EMPLOYEES",
      employeeIds: expect.arrayContaining([ANNA_EMP, MAREK_EMP]),
    });
    expect(result.entries.map((e) => e.employee)).toEqual([
      { id: ANNA_EMP, firstName: "Anna", lastName: "Nowak" },
      { id: MAREK_EMP, firstName: "Marek", lastName: "Kowalski" },
    ]);
    // Stronicowanie po 1 elemencie wymusiło wiele zapytań z kursorem
    expect(unitMemberRequests.length).toBeGreaterThanOrEqual(2);
    expect(employeeRequests.length).toBeGreaterThanOrEqual(2);
    // Katalog pracowników został zapytany wyłącznie o Annę i Marka, bez Piotra
    for (const ids of employeeRequests) {
      expect(ids).not.toContain(PIOTR_EMP);
    }
  });

  it("zakres ORGANIZATION widzi wszystkich pracowników firmy bez wywoływania directory/unit-members", async () => {
    snapshotsByAccount.set(JAN_ACC, {
      accountId: JAN_ACC,
      organizationId: ACME,
      authzRevision: 0,
      isOwner: true,
      products: ["timotime"],
      grants: [],
      units: ACME_UNITS,
    });

    const { capturedScopes } = mockTeamDb([
      makeDbRow(ANNA_ACC, ANNA_EMP, new Date("2026-11-24T12:00:00.000Z")),
      makeDbRow(PIOTR_ACC, PIOTR_EMP, new Date("2026-11-24T12:00:00.000Z")),
    ]);

    const result = await listTeamTimeEntries(makeCaller(JAN_ACC, JAN_EMP), { from: "2026-11-24", to: "2026-11-24" });
    expect(capturedScopes).toEqual([{ type: "ALL" }]);
    expect(unitMemberRequests).toEqual([]);
    expect(result.entries.map((e) => e.employee.firstName)).toEqual(["Anna", "Piotr"]);
  });

  it("pomija nadania typu RESOURCE bez pytania o wszystkie jednostki firmy", async () => {
    snapshotsByAccount.set(JAN_ACC, {
      accountId: JAN_ACC,
      organizationId: ACME,
      authzRevision: 0,
      isOwner: false,
      products: ["timotime"],
      grants: [
        {
          permission: "timotime.entries.read",
          scope: { type: "RESOURCE", resourceId: "project-1" },
        },
      ],
      units: ACME_UNITS,
    });

    const { capturedScopes } = mockTeamDb([makeDbRow(ANNA_ACC, ANNA_EMP, null)]);
    const result = await getTeamCurrentEntries(makeCaller(JAN_ACC, JAN_EMP));
    expect(result.entries).toEqual([]);
    expect(unitMemberRequests).toEqual([]);
    expect(capturedScopes).toEqual([]);
  });

  it("dzieli zapytania do directory/employees na paczki po 100 identyfikatorów", async () => {
    snapshotsByAccount.set(JAN_ACC, {
      accountId: JAN_ACC,
      organizationId: ACME,
      authzRevision: 0,
      isOwner: true,
      products: ["timotime"],
      grants: [],
      units: ACME_UNITS,
    });

    const rows: dbModule.TimeEntryModel[] = [];
    directoryEmployees = [];
    for (let i = 0; i < 125; i += 1) {
      const empId = randomUUID();
      const accId = randomUUID();
      directoryEmployees.push({
        id: empId,
        accountId: accId,
        firstName: `Imie${i}`,
        lastName: `Nazwisko${i}`,
        status: "ACTIVE",
      });
      rows.push(makeDbRow(accId, empId, null));
    }

    mockTeamDb(rows);
    const result = await getTeamCurrentEntries(makeCaller(JAN_ACC, JAN_EMP));
    expect(result.entries).toHaveLength(125);
    expect(employeeRequests.map((batch) => batch.length)).toEqual([100, 25]);
  });
});
