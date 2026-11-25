/**
 * Testy odporności serwera TimoTime na krótkie awarie MonoriseCore (ponawianie w `@monorise-team/sdk`,
 * bezpieczna odmowa 503 po wyczerpaniu prób) oraz wielostronicowego katalogu Core (`directoryPageSize`).
 *
 * Testy działają na prawdziwych trasach Next.js (`/api/v1/me`, `/api/v1/team/current`, `/api/v1/team/entries`)
 * z atrapą `createFakeCore` podpiętą pod `globalThis.fetch`, bez bazy PostgreSQL i bez gniazd TCP.
 */
import type { Authenticated, Session } from "@monorise-team/auth/next";
import {
  checkErrorEnvelope,
  createFakeCore,
  type CreatedEmployeeWithAccount,
  type FakeCore,
  type FakeOrganizationBuilder,
} from "@monorise-team/testing";
import { TIMOTIME_PERMISSIONS } from "@timotime/contracts";
import * as dbModule from "@timotime/db";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as me from "@/app/api/v1/me/route";
import * as teamCurrent from "@/app/api/v1/team/current/route";
import * as teamEntries from "@/app/api/v1/team/entries/route";
import { getAuth } from "@/server/auth";
import { DEFAULT_CORE_RETRY, resetMachineCoreTokenCache, setCoreRetryForTests } from "@/server/core";
import {
  CORE_DIRECTORY_READ_SCOPE,
  CORE_EVENTS_READ_SCOPE,
  CORE_PERMISSIONS_READ_SCOPE,
  CORE_PERMISSIONS_REGISTER_SCOPE,
} from "@/server/core-machine";
import * as serverDb from "@/server/db";
import { invalidatePermissionCache } from "@/server/permissions";

const API = "http://time.localhost:3300";
const BASE = `${API}/api/v1`;
const FAKE_CORE_URL = "http://core.resilience.test";
const CLIENT_ID = "timotime-web";
const CLIENT_SECRET = "sekret-klienta-tylko-do-testow";
const FAST_RETRY = { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 } as const;

function call(
  handler: (request: NextRequest, context: { params: Promise<Record<string, never>> }) => Promise<Response>,
  path: string,
  init: { token?: string } = {},
) {
  const headers: Record<string, string> = { host: "time.localhost:3300" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const request = new NextRequest(`${BASE}${path}`, { method: "GET", headers });
  return handler(request, { params: Promise.resolve({}) });
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

function mockTeamDb(allRows: dbModule.TimeEntryModel[]) {
  vi.spyOn(serverDb, "getDb").mockReturnValue({} as dbModule.PrismaClient);
  vi.spyOn(dbModule, "withTeamScope").mockImplementation(async (_db, _actor, scope, fn) => {
    const visible =
      scope.type === "ALL" ? allRows : allRows.filter((row) => scope.employeeIds.includes(row.employeeId));
    const fakeTx = {
      timeEntry: {
        findMany: async () => visible,
      },
    } as unknown as dbModule.Tx;
    return fn(fakeTx);
  });
}

function mockBrowserSession(
  employee: CreatedEmployeeWithAccount,
  organizationId: string,
  coreAccessToken: string,
  authzRevision = employee.account.authzRevision,
) {
  const context = {
    accountId: employee.accountId,
    organizationId,
    employeeId: employee.employeeId,
    sessionId: "sesja-resilience",
    authzRevision,
    methods: [],
    clientId: CLIENT_ID,
    scopes: ["openid", "profile", "email", "offline_access"],
    expiresAt: new Date(Date.now() + 5 * 60_000),
  };
  const session: Session = {
    context,
    profile: { email: employee.account.email, name: `${employee.firstName} ${employee.lastName}` },
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    accessToken: async () => coreAccessToken,
    setCookies: [],
  };
  const authenticated: Authenticated = { context, via: "session", session, setCookies: [] };
  vi.spyOn(getAuth(), "authenticate").mockResolvedValue(authenticated);
}

let fakeCore: FakeCore;
let acme: FakeOrganizationBuilder;
let anna: CreatedEmployeeWithAccount;
let unitKrakowId: string;
let employeeRoleId: string;
let managerReadRoleId: string;

function setupDefaultAcme(): void {
  acme = fakeCore.organization({ name: "Acme", domain: "acme.test" });
  acme.grantEntitlement("timotime");

  const krakow = acme.addUnit({ name: "Oddział Kraków", type: "BRANCH" });
  unitKrakowId = krakow.id;

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

  anna = acme.addEmployee({
    firstName: "Anna",
    lastName: "Nowak",
    email: "anna@acme.test",
    unitIds: [unitKrakowId],
    products: ["timotime"],
  });
  acme.assignRole({ accountId: anna.accountId, roleId: employeeRoleId, scope: { type: "ORGANIZATION" } });
}

beforeAll(async () => {
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
        ],
      },
    ],
  });
  process.env.CORE_AUTH_URL = FAKE_CORE_URL;
  process.env.CORE_API_URL = FAKE_CORE_URL;
  delete process.env.TIMOTIME_CORE_JWKS;
});

beforeEach(() => {
  fakeCore.reset();
  fakeCore.setDirectoryPageSize(undefined);
  setupDefaultAcme();
  process.env.CORE_AUTH_URL = FAKE_CORE_URL;
  process.env.CORE_API_URL = FAKE_CORE_URL;
  invalidatePermissionCache();
  resetMachineCoreTokenCache();
  setCoreRetryForTests(FAST_RETRY);
  vi.spyOn(globalThis, "fetch").mockImplementation(fakeCore.fetch as typeof fetch);
});

afterEach(() => {
  fakeCore.clearFaults();
  fakeCore.resetCalls();
  fakeCore.setDirectoryPageSize(undefined);
  setCoreRetryForTests();
  vi.restoreAllMocks();
});

describe("odporność serwera TimoTime na krótkie awarie MonoriseCore", () => {
  it("udostępnia domyślną politykę ponawiania (3 próby, 200-2000 ms)", () => {
    expect(DEFAULT_CORE_RETRY).toEqual({
      attempts: 3,
      baseDelayMs: 200,
      maxDelayMs: 2000,
    });
  });

  it("ponawia pojedyncze 503 na permissionSnapshot i kończy żądanie sukcesem", async () => {
    const coreToken = await acme.signUserToken(anna.accountId, { audience: fakeCore.coreApiUrl });
    mockBrowserSession(anna, acme.id, coreToken);
    fakeCore.failNext("permissionSnapshot", { status: 503 });

    const response = await call(me.GET, "/me");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { employee: { firstName: string }; capabilities: { trackOwnTime: boolean; viewTeam: boolean } };
      error: null;
    };
    expect(body.error).toBeNull();
    expect(body.data.employee.firstName).toBe("Anna");
    expect(body.data.capabilities).toEqual({ trackOwnTime: true, viewTeam: false });
    expect(fakeCore.calls("permissionSnapshot")).toBe(2);
  });

  it("ponawia pojedynczy błąd sieci na directoryUnitMembers w widoku zespołu", async () => {
    const jan = acme.addEmployee({ firstName: "Jan", lastName: "Kowalski", products: ["timotime"] });
    acme.assignRole({
      accountId: jan.accountId,
      roleId: managerReadRoleId,
      scope: { type: "UNIT", unitId: unitKrakowId },
    });
    const janToken = await acme.signUserToken(jan.accountId, { audience: API });

    mockTeamDb([makeDbRow(acme.id, anna.accountId, anna.employeeId, null)]);
    fakeCore.failNext("directoryUnitMembers", { networkError: true });

    const response = await call(teamCurrent.GET, "/team/current", { token: janToken });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { entries: { employee: { id: string; firstName: string; lastName: string } }[] };
      error: null;
    };
    expect(body.error).toBeNull();
    expect(body.data.entries.map((entry) => entry.employee)).toEqual([
      { id: anna.employeeId, firstName: "Anna", lastName: "Nowak" },
    ]);
    expect(fakeCore.calls("directoryUnitMembers")).toBe(2);
  });

  it("ponawia pojedyncze 429 z Retry-After: 0 na /core/v1/me w GET /api/v1/me", async () => {
    const coreToken = await acme.signUserToken(anna.accountId, { audience: fakeCore.coreApiUrl });
    mockBrowserSession(anna, acme.id, coreToken);
    fakeCore.failNext("me", { status: 429, retryAfterSeconds: 0 });

    const response = await call(me.GET, "/me");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { account: { email: string }; organization: { name: string } };
      error: null;
    };
    expect(body.error).toBeNull();
    expect(body.data.account.email).toBe("anna@acme.test");
    expect(body.data.organization.name).toBe("Acme");
    expect(fakeCore.calls("me")).toBe(2);
  });

  it("zwraca 503 w standardowej kopercie błędu przy trwałym 503 na permissionSnapshot i nie podaje starej migawki", async () => {
    const coreToken = await acme.signUserToken(anna.accountId, { audience: fakeCore.coreApiUrl });
    mockBrowserSession(anna, acme.id, coreToken);

    // 1. Trwałe 503 (więcej niż liczba prób) bez wcześniejszej migawki w cache
    fakeCore.failNext("permissionSnapshot", { status: 503 }, { times: FAST_RETRY.attempts + 2 });

    const firstFailure = await call(me.GET, "/me");
    const envelopeCheck = await checkErrorEnvelope(firstFailure.clone(), {
      expectedStatus: 503,
      expectedCode: "INTERNAL",
    });
    expect(envelopeCheck.passed, envelopeCheck.violations.join("; ")).toBe(true);
    const firstBody = (await firstFailure.json()) as {
      data: null;
      meta: { requestId: string };
      error: { code: string; message: string; details: unknown[] };
    };
    expect(firstBody).toEqual({
      data: null,
      meta: { requestId: expect.stringMatching(/^req_/) },
      error: {
        code: "INTERNAL",
        message: "MonoriseCore jest chwilowo niedostępny",
        details: [],
      },
    });
    expect(fakeCore.calls("permissionSnapshot")).toBe(FAST_RETRY.attempts);

    // 2. Po zapisaniu migawki w cache i wzroście authz_rev trwałe 503 nadal odmawia (fail-closed)
    fakeCore.clearFaults();
    fakeCore.resetCalls();

    const okResponse = await call(me.GET, "/me");
    expect(okResponse.status).toBe(200);
    expect(fakeCore.calls("permissionSnapshot")).toBe(1);

    const nextRev = acme.bumpAuthzRevision(anna.accountId);
    mockBrowserSession(anna, acme.id, coreToken, nextRev);
    fakeCore.failNext("permissionSnapshot", { status: 503 }, { times: FAST_RETRY.attempts + 2 });

    const failClosed = await call(me.GET, "/me");
    const failClosedCheck = await checkErrorEnvelope(failClosed.clone(), {
      expectedStatus: 503,
      expectedCode: "INTERNAL",
    });
    expect(failClosedCheck.passed, failClosedCheck.violations.join("; ")).toBe(true);
    expect(fakeCore.calls("permissionSnapshot")).toBe(1 + FAST_RETRY.attempts);
  });

  it("pobiera wszystkich pracowników w widoku zespołu przy stronicowaniu katalogu directoryPageSize: 2", async () => {
    fakeCore.setDirectoryPageSize(2);

    const jan = acme.addEmployee({ firstName: "Jan", lastName: "Kierownik", products: ["timotime"] });
    acme.assignRole({
      accountId: jan.accountId,
      roleId: managerReadRoleId,
      scope: { type: "UNIT", unitId: unitKrakowId },
    });
    const janToken = await acme.signUserToken(jan.accountId, { audience: API });

    const teamMembers = [
      anna,
      acme.addEmployee({ firstName: "Bartek", lastName: "Bąk", unitIds: [unitKrakowId], products: ["timotime"] }),
      acme.addEmployee({ firstName: "Celina", lastName: "Cicha", unitIds: [unitKrakowId], products: ["timotime"] }),
      acme.addEmployee({ firstName: "Damian", lastName: "Dąb", unitIds: [unitKrakowId], products: ["timotime"] }),
      acme.addEmployee({ firstName: "Ewa", lastName: "Eska", unitIds: [unitKrakowId], products: ["timotime"] }),
    ];

    const rows = teamMembers.map((member) => makeDbRow(acme.id, member.accountId, member.employeeId, null));
    mockTeamDb(rows);

    const response = await call(teamEntries.GET, "/team/entries?from=2026-11-24&to=2026-11-24", { token: janToken });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { entries: { employee: { id: string; firstName: string; lastName: string } }[] };
      error: null;
    };
    expect(body.error).toBeNull();
    expect(body.data.entries).toHaveLength(5);
    expect(body.data.entries.map((entry) => entry.employee)).toEqual(
      teamMembers.map((member) => ({
        id: member.employeeId,
        firstName: member.firstName,
        lastName: member.lastName,
      })),
    );
    // 5 pracowników przy rozmiarze strony 2 wymaga co najmniej 3 stron z obu endpointów katalogu
    expect(fakeCore.calls("directoryUnitMembers")).toBe(3);
    expect(fakeCore.calls("directoryEmployees")).toBe(3);
  });
});
