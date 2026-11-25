/**
 * Testy API na prawdziwych trasach Next.js: atrapa MonoriseCore (`createFakeCore` z `@monorise-team/testing`)
 * udostępniająca JWKS, OAuth `client_credentials`, `/core/v1/me`, migawkę uprawnień i katalog pracowników
 * (podpięta pod `globalThis.fetch` bez gniazd TCP) oraz baza PostgreSQL z RLS.
 */
import type { Authenticated, Session } from "@monorise-team/auth/next";
import {
  createFakeCore,
  type CreatedEmployeeWithAccount,
  type FakeCore,
  type FakeOrganizationBuilder,
} from "@monorise-team/testing";
import { TIMOTIME_PERMISSIONS } from "@timotime/contracts";
import { uuidv7, withUser } from "@timotime/db";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as signInRoute from "@/app/api/auth/sign-in/route";
import * as health from "@/app/api/v1/health/route";
import * as me from "@/app/api/v1/me/route";
import * as teamCurrent from "@/app/api/v1/team/current/route";
import * as teamEntries from "@/app/api/v1/team/entries/route";
import * as current from "@/app/api/v1/time/current/route";
import * as entries from "@/app/api/v1/time/entries/route";
import * as start from "@/app/api/v1/time/start/route";
import * as stop from "@/app/api/v1/time/stop/route";
import { getAuth } from "@/server/auth";
import { resetMachineCoreTokenCache } from "@/server/core";
import {
  CORE_DIRECTORY_READ_SCOPE,
  CORE_EVENTS_READ_SCOPE,
  CORE_PERMISSIONS_READ_SCOPE,
  CORE_PERMISSIONS_REGISTER_SCOPE,
} from "@/server/core-machine";
import { getDb } from "@/server/db";
import { invalidatePermissionCache, PRODUCT_ACCESS_REQUIRED_MESSAGE } from "@/server/permissions";

const API = "http://time.localhost:3300";
const BASE = `${API}/api/v1`;
const FAKE_CORE_URL = "http://core.api.test";
const CLIENT_ID = "timotime-web";
const CLIENT_SECRET = "sekret-klienta-tylko-do-testow";

function call<P>(
  handler: (request: NextRequest, context: { params: Promise<P> }) => Promise<Response>,
  path: string,
  init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
  params = {} as P,
) {
  const headers: Record<string, string> = { host: "time.localhost:3300", ...init.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const request = new NextRequest(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return handler(request, { params: Promise.resolve(params) }).then(async (response) => ({
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- w testach czytamy odpowiedzi API swobodnie
    body: (await response.json()) as { data: any; meta: { requestId: string }; error: any },
    response,
  }));
}

let fakeCore: FakeCore;
let acme: FakeOrganizationBuilder;
let anna: CreatedEmployeeWithAccount;
let unitKrakowId: string;
let employeeRoleId: string;
let managerReadRoleId: string;

/**
 * Cienki adapter wokół `fakeCore.fetch` dla scenariuszy, których `createFakeCore` nie konfiguruje:
 * - wstrzykiwanie błędu 500 albo błędu sieci dla wybranej ścieżki Core,
 * - ograniczenie `limit` w zapytaniach do katalogu, aby wymusić wielostronicowe stronicowanie kursorowe.
 */
let faultPath: string | null = null;
let directoryMaxLimit: number | null = null;

async function coreFetchAdapter(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(rawUrl);

  if (url.origin !== FAKE_CORE_URL) {
    throw new TypeError(`connect ECONNREFUSED ${url.host}`);
  }

  if (faultPath !== null && url.pathname === faultPath) {
    return new Response(
      JSON.stringify({
        data: null,
        meta: { requestId: "req_core_500" },
        error: { code: "INTERNAL", message: "Core failure", details: [] },
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
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

function setupDefaultAcme(): void {
  acme = fakeCore.organization({ name: "Acme", domain: "acme.test" });
  acme.grantEntitlement("timotime");

  const krakow = acme.addUnit({ name: "Oddział Kraków", type: "BRANCH" });
  const sales = acme.addUnit({ name: "Dział Sprzedaży", type: "DEPARTMENT", parentId: krakow.id });
  acme.addUnit({ name: "Zespół Kraków A", type: "TEAM", parentId: sales.id });
  acme.addUnit({ name: "Oddział Warszawa", type: "BRANCH" });
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
    jobTitle: "Specjalistka logistyki",
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
  setupDefaultAcme();
  faultPath = null;
  directoryMaxLimit = null;
  process.env.CORE_AUTH_URL = FAKE_CORE_URL;
  process.env.CORE_API_URL = FAKE_CORE_URL;
  invalidatePermissionCache();
  resetMachineCoreTokenCache();
  vi.spyOn(globalThis, "fetch").mockImplementation(coreFetchAdapter as typeof fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

/** Tworzy pracownika w firmie z dostępem do TimoTime oraz rolą Pracownik i podpisuje jego token API. */
async function signInEmployee(
  org: FakeOrganizationBuilder = acme,
  roleId: string = employeeRoleId,
  options: { firstName?: string; lastName?: string; unitIds?: string[] } = {},
) {
  const emp = org.addEmployee({
    firstName: options.firstName ?? "Pracownik",
    lastName: options.lastName ?? "Testowy",
    unitIds: options.unitIds,
    products: ["timotime"],
  });
  org.assignRole({ accountId: emp.accountId, roleId, scope: { type: "ORGANIZATION" } });
  const token = await org.signUserToken(emp.accountId, { audience: API });
  return {
    accountId: emp.accountId,
    organizationId: org.id,
    employeeId: emp.employeeId,
    token,
  };
}

/** Sesja przeglądarki (BFF) udająca `getAuth().authenticate` z dostępem do tokenu Core API. */
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
    sessionId: "sesja-core",
    authzRevision,
    methods: [],
    clientId: CLIENT_ID,
    scopes: ["openid", "profile", "email", "offline_access"],
    expiresAt: new Date(Date.now() + 5 * 60_000),
  };
  const requestedResources: (string | undefined)[] = [];
  const session: Session = {
    context,
    profile: { email: employee.account.email, name: `${employee.firstName} ${employee.lastName}` },
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    accessToken: async (resource?: string) => {
      requestedResources.push(resource);
      return coreAccessToken;
    },
    // Sesja w bazie (tryb store) nigdy nie zwraca ciasteczek do zapisania
    setCookies: [],
  };
  const authenticated: Authenticated = { context, via: "session", session, setCookies: [] };
  vi.spyOn(getAuth(), "authenticate").mockResolvedValue(authenticated);
  return { requestedResources };
}

describe("API: sesja, Core SDK, uprawnienia i walidacja", () => {
  it("health odpowiada ok w formacie { data, meta, error }", async () => {
    const { status, body } = await call(health.GET, "/health");
    expect(status).toBe(200);
    expect(body.data.status).toBe("ok");
    expect(body.error).toBeNull();
    expect(body.meta.requestId).toMatch(/^req_/);
  });

  it("bez sesji odpowiada UNAUTHENTICATED w formacie { data, meta, error }", async () => {
    const { status, body } = await call(me.GET, "/me");
    expect(status).toBe(401);
    expect(body.data).toBeNull();
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(body.meta.requestId).toMatch(/^req_/);
  });

  it("GET /api/v1/me z sesją przeglądarki (BFF) pobiera osobę, firmę i capabilities z Core", async () => {
    const coreApiToken = await acme.signUserToken(anna.accountId, { audience: fakeCore.coreApiUrl });
    const { requestedResources } = mockBrowserSession(anna, acme.id, coreApiToken);

    const { status, body } = await call(me.GET, "/me");
    expect(status).toBe(200);
    expect(requestedResources).toEqual([fakeCore.coreApiUrl]);
    expect(body.data).toMatchObject({
      account: { id: anna.accountId, email: "anna@acme.test" },
      employee: {
        id: anna.employeeId,
        firstName: "Anna",
        lastName: "Nowak",
        fullName: "Anna Nowak",
        jobTitle: "Specjalistka logistyki",
      },
      organization: { id: acme.id, name: "Acme" },
      capabilities: { trackOwnTime: true, viewTeam: false },
    });

    // Po nadaniu roli Kierownik i podbiciu authz_rev pamięć podręczna odświeża capabilities
    acme.assignRole({
      accountId: anna.accountId,
      roleId: managerReadRoleId,
      scope: { type: "UNIT", unitId: unitKrakowId },
    });
    const nextRev = acme.bumpAuthzRevision(anna.accountId);
    mockBrowserSession(anna, acme.id, coreApiToken, nextRev);
    const refreshed = await call(me.GET, "/me");
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.capabilities).toEqual({ trackOwnTime: true, viewTeam: true });
    expect(fakeCore.calls.permissionSnapshot).toBe(2);
    // Token maszynowy został pobrany raz i użyty ponownie z cache
    expect(fakeCore.calls.token).toBe(1);
  });

  it("GET /api/v1/me odrzuca token bearer z telefonu (403 PERMISSION_DENIED) zamiast przekazywać go do Core", async () => {
    const token = await acme.signUserToken(anna.accountId, { audience: API });
    const { status, body } = await call(me.GET, "/me", { token });
    expect(status).toBe(403);
    expect(body.data).toBeNull();
    expect(body.error.code).toBe("PERMISSION_DENIED");
    expect(body.error.message).toMatch(/Core API/);
  });

  it("mapuje błędy Core API na 401 i 503 dla sesji BFF i niedostępności migawki", async () => {
    const expiredCoreToken = await fakeCore.issuer.invalid.expired({
      accountId: anna.accountId,
      organizationId: acme.id,
      employeeId: anna.employeeId,
      audience: fakeCore.coreApiUrl,
    });
    mockBrowserSession(anna, acme.id, expiredCoreToken);

    const unauth = await call(me.GET, "/me");
    expect(unauth.status).toBe(401);
    expect(unauth.body.error.code).toBe("UNAUTHENTICATED");

    const validCoreToken = await acme.signUserToken(anna.accountId, { audience: fakeCore.coreApiUrl });
    mockBrowserSession(anna, acme.id, validCoreToken);

    faultPath = "/core/v1/me";
    const failed = await call(me.GET, "/me");
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe("INTERNAL");

    faultPath = "/core/v1/products/timotime/permission-snapshot";
    const snapFailed = await call(me.GET, "/me");
    expect(snapFailed.status).toBe(503);
    expect(snapFailed.body.error.code).toBe("INTERNAL");

    faultPath = null;
    process.env.CORE_API_URL = "http://127.0.0.1:1";
    const unavailable = await call(me.GET, "/me");
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error.code).toBe("INTERNAL");
  });

  it("migawka bez produktu timotime zwraca 403 PRODUCT_ACCESS_REQUIRED z polskim komunikatem na własnych wpisach i widoku zespołu", async () => {
    const blocked = acme.addEmployee({ firstName: "Zablokowana", lastName: "Osoba", products: [] });
    const token = await acme.signUserToken(blocked.accountId, { audience: API });

    for (const res of [
      await call(current.GET, "/time/current", { token }),
      await call(entries.GET, "/time/entries", { token }),
      await call(start.POST, "/time/start", { method: "POST", token, body: { kind: "WORK" } }),
      await call(teamCurrent.GET, "/team/current", { token }),
      await call(teamEntries.GET, "/team/entries", { token }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("PRODUCT_ACCESS_REQUIRED");
      expect(res.body.error.message).toBe(PRODUCT_ACCESS_REQUIRED_MESSAGE);
    }
  });

  it("pracownik bez timotime.entries.read dostaje 403 PERMISSION_DENIED na trasach zespołu", async () => {
    const token = await acme.signUserToken(anna.accountId, { audience: API });
    const cur = await call(teamCurrent.GET, "/team/current", { token });
    expect(cur.status).toBe(403);
    expect(cur.body.error.code).toBe("PERMISSION_DENIED");

    const list = await call(teamEntries.GET, "/team/entries", { token });
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe("PERMISSION_DENIED");
  });

  it("odrzuca token dla innego API i token po terminie", async () => {
    const base = {
      accountId: anna.accountId,
      organizationId: acme.id,
      employeeId: anna.employeeId,
      audience: API,
    };
    const otherApi = await fakeCore.issuer.invalid.wrongAudience(base, "http://localhost:3200");
    expect((await call(me.GET, "/me", { token: otherApi })).status).toBe(401);
    const expired = await fakeCore.issuer.invalid.expired(base);
    expect((await call(me.GET, "/me", { token: expired })).body.error.code).toBe("UNAUTHENTICATED");
  });

  it("logowanie w przeglądarce przekierowuje do Core z PKCE i oboma API", async () => {
    const response = await signInRoute.GET(new Request("http://timo-time.localhost:3300/api/auth/sign-in?returnTo=/"));
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("location") ?? "");
    expect(`${target.origin}${target.pathname}`).toBe(`${fakeCore.issuerUrl}/api/auth/oauth2/authorize`);
    expect(target.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(target.searchParams.get("redirect_uri")).toBe("http://timo-time.localhost:3300/api/auth/callback");
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(target.searchParams.getAll("resource")).toEqual([API, fakeCore.coreApiUrl]);
    expect(response.headers.get("set-cookie")).toMatch(/^monorise-oauth=.*HttpOnly; SameSite=Lax/);
  });

  it("odrzuca zmianę z ciasteczkiem spoza strony (CSRF)", async () => {
    const { status, body } = await call(start.POST, "/time/start", {
      method: "POST",
      body: { kind: "WORK" },
      headers: { cookie: "monorise-session=x", origin: "https://zla-strona.example" },
    });
    expect(status).toBe(403);
    expect(body.error.code).toBe("PERMISSION_DENIED");
  });

  it("waliduje rodzaj wpisu i zakres dat (maksymalnie 31 dni) dla własnych wpisów i zespołu", async () => {
    const token = await acme.signUserToken(anna.accountId, { audience: API });
    const badKind = await call(start.POST, "/time/start", {
      method: "POST",
      token,
      body: { kind: "INVALID_KIND" },
    });
    expect(badKind.status).toBe(422);
    expect(badKind.body.error.code).toBe("VALIDATION_FAILED");
    expect(badKind.body.error.details.map((d: { field: string }) => d.field)).toContain("kind");

    const tooLong = await call(entries.GET, "/time/entries?from=2026-10-01&to=2026-11-15", { token });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.error.code).toBe("VALIDATION_FAILED");

    const reversed = await call(entries.GET, "/time/entries?from=2026-11-24&to=2026-11-20", { token });
    expect(reversed.status).toBe(422);
    expect(reversed.body.error.code).toBe("VALIDATION_FAILED");

    const teamTooLong = await call(teamEntries.GET, "/team/entries?from=2026-10-01&to=2026-11-15", { token });
    expect(teamTooLong.status).toBe(422);
    expect(teamTooLong.body.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("API: rejestracja czasu pracy i widok zespołu (PostgreSQL z RLS)", () => {
  it("przełącza statusy praca -> przerwa -> praca, zamyka wpis i listuje dzisiejsze wpisy", async () => {
    const emp = await signInEmployee();

    const empty = await call(current.GET, "/time/current", { token: emp.token });
    expect(empty.status).toBe(200);
    expect(empty.body.data).toBeNull();

    const stopEmpty = await call(stop.POST, "/time/stop", { method: "POST", token: emp.token });
    expect(stopEmpty.status).toBe(409);
    expect(stopEmpty.body.error.code).toBe("CONFLICT");

    const work1 = await call(start.POST, "/time/start", {
      method: "POST",
      token: emp.token,
      body: { kind: "WORK", note: "Start zmiany" },
    });
    expect(work1.status).toBe(201);
    expect(work1.body.data).toMatchObject({
      kind: "WORK",
      endedAt: null,
      note: "Start zmiany",
      accountId: emp.accountId,
      organizationId: emp.organizationId,
    });

    const active1 = await call(current.GET, "/time/current", { token: emp.token });
    expect(active1.body.data.id).toBe(work1.body.data.id);

    const brk = await call(start.POST, "/time/start", {
      method: "POST",
      token: emp.token,
      body: { kind: "BREAK" },
    });
    expect(brk.status).toBe(201);
    expect(brk.body.data).toMatchObject({ kind: "BREAK", endedAt: null });

    const work2 = await call(start.POST, "/time/start", {
      method: "POST",
      token: emp.token,
      body: { kind: "REMOTE" },
    });
    expect(work2.status).toBe(201);
    expect(work2.body.data).toMatchObject({ kind: "REMOTE", endedAt: null });

    const stopped = await call(stop.POST, "/time/stop", { method: "POST", token: emp.token });
    expect(stopped.status).toBe(200);
    expect(stopped.body.data.id).toBe(work2.body.data.id);
    expect(stopped.body.data.endedAt).not.toBeNull();

    const afterStop = await call(current.GET, "/time/current", { token: emp.token });
    expect(afterStop.body.data).toBeNull();

    const list = await call(entries.GET, "/time/entries", { token: emp.token });
    expect(list.status).toBe(200);
    expect(list.body.data.entries).toHaveLength(3);
    expect(list.body.data.entries.map((item: { kind: string }) => item.kind)).toEqual(["REMOTE", "BREAK", "WORK"]);
    for (const item of list.body.data.entries as { endedAt: string | null }[]) {
      expect(item.endedAt).not.toBeNull();
    }
  });

  it("zwraca 409 CONFLICT przy dwóch równoczesnych wywołaniach start i zostawia jeden otwarty wpis", async () => {
    const emp = await signInEmployee();
    // Rozgrzanie dwóch połączeń z puli przed równoczesnym startem
    const warmup = await Promise.all([
      call(current.GET, "/time/current", { token: emp.token }),
      call(current.GET, "/time/current", { token: emp.token }),
    ]);
    expect(warmup.map((item) => item.body.data)).toEqual([null, null]);

    const results = await Promise.all([
      call(start.POST, "/time/start", { method: "POST", token: emp.token, body: { kind: "WORK" } }),
      call(start.POST, "/time/start", { method: "POST", token: emp.token, body: { kind: "WORK" } }),
    ]);
    const statuses = results.map((result) => result.status).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    const conflict = results.find((result) => result.status === 409);
    expect(conflict?.body.error.code).toBe("CONFLICT");
    expect(conflict?.body.error.message).toBe("Masz już otwarty wpis");

    const openEntries = await withUser(
      getDb(),
      { organizationId: emp.organizationId, accountId: emp.accountId },
      (tx) => tx.timeEntry.findMany({ where: { endedAt: null } }),
    );
    expect(openEntries).toHaveLength(1);
  });

  it("GET /api/v1/time/entries uwzględnia wpisy nakładające się na zakres (np. praca nocna 22:00-02:00)", async () => {
    const emp = await signInEmployee();
    const actor = { organizationId: emp.organizationId, accountId: emp.accountId };
    const earlierId = uuidv7(Date.parse("2026-11-23T08:00:00.000Z"));
    const overnightId = uuidv7(Date.parse("2026-11-23T22:00:00.000Z"));
    const daytimeId = uuidv7(Date.parse("2026-11-24T09:00:00.000Z"));
    const openBeforeRangeId = uuidv7(Date.parse("2026-11-24T22:00:00.000Z"));

    await withUser(getDb(), actor, async (tx) => {
      await tx.timeEntry.createMany({
        data: [
          {
            id: earlierId,
            organizationId: emp.organizationId,
            accountId: emp.accountId,
            employeeId: emp.employeeId,
            kind: "WORK",
            startedAt: new Date("2026-11-23T08:00:00.000Z"),
            endedAt: new Date("2026-11-23T16:00:00.000Z"),
          },
          {
            id: overnightId,
            organizationId: emp.organizationId,
            accountId: emp.accountId,
            employeeId: emp.employeeId,
            kind: "WORK",
            startedAt: new Date("2026-11-23T22:00:00.000Z"),
            endedAt: new Date("2026-11-24T02:00:00.000Z"),
          },
          {
            id: daytimeId,
            organizationId: emp.organizationId,
            accountId: emp.accountId,
            employeeId: emp.employeeId,
            kind: "REMOTE",
            startedAt: new Date("2026-11-24T09:00:00.000Z"),
            endedAt: new Date("2026-11-24T12:00:00.000Z"),
          },
          {
            id: openBeforeRangeId,
            organizationId: emp.organizationId,
            accountId: emp.accountId,
            employeeId: emp.employeeId,
            kind: "WORK",
            startedAt: new Date("2026-11-24T22:00:00.000Z"),
            endedAt: null,
          },
        ],
      });
    });

    const day24 = await call(entries.GET, "/time/entries?from=2026-11-24&to=2026-11-24", { token: emp.token });
    expect(day24.status).toBe(200);
    expect(day24.body.data.entries.map((item: { id: string }) => item.id)).toEqual([
      openBeforeRangeId,
      daytimeId,
      overnightId,
    ]);

    const day25 = await call(entries.GET, "/time/entries?from=2026-11-25&to=2026-11-25", { token: emp.token });
    expect(day25.status).toBe(200);
    expect(day25.body.data.entries.map((item: { id: string }) => item.id)).toEqual([openBeforeRangeId]);
  });

  it("osoba z innej firmy ani współpracownik nie widzi i nie zamknie cudzego wpisu", async () => {
    const globex = fakeCore.organization({ name: "Globex", domain: "globex.test" });
    globex.grantEntitlement("timotime");
    const globexRole = globex.addRole({
      name: "Pracownik",
      product: "timotime",
      permissions: [TIMOTIME_PERMISSIONS.keys["entries.read_own"], TIMOTIME_PERMISSIONS.keys["entries.write_own"]],
    });

    const empAnna = await signInEmployee(acme, employeeRoleId);
    const bartek = await signInEmployee(acme, employeeRoleId);
    const celina = await signInEmployee(globex, globexRole.id);

    const started = await call(start.POST, "/time/start", {
      method: "POST",
      token: empAnna.token,
      body: { kind: "WORK" },
    });
    expect(started.status).toBe(201);

    for (const other of [bartek, celina]) {
      expect((await call(current.GET, "/time/current", { token: other.token })).body.data).toBeNull();
      expect((await call(entries.GET, "/time/entries", { token: other.token })).body.data.entries).toEqual([]);
      expect((await call(stop.POST, "/time/stop", { method: "POST", token: other.token })).status).toBe(409);
    }

    expect((await call(current.GET, "/time/current", { token: empAnna.token })).body.data.id).toBe(
      started.body.data.id,
    );
  });

  it("Jan (UNIT Kraków) widzi Annę i Marka z podjednostek Krakowa, a nie Piotra (Warszawa) ani Celiny (inna firma); ORGANIZATION widzi całą firmę", async () => {
    const teamOrg = fakeCore.organization({ name: "Acme Zespół", domain: "acme-team.test" });
    teamOrg.grantEntitlement("timotime");
    const krakow = teamOrg.addUnit({ name: "Oddział Kraków", type: "BRANCH" });
    const sales = teamOrg.addUnit({ name: "Dział Sprzedaży", type: "DEPARTMENT", parentId: krakow.id });
    const krakowA = teamOrg.addUnit({ name: "Zespół Kraków A", type: "TEAM", parentId: sales.id });
    const warszawa = teamOrg.addUnit({ name: "Oddział Warszawa", type: "BRANCH" });

    const teamEmpRole = teamOrg.addRole({
      name: "Pracownik",
      product: "timotime",
      permissions: [TIMOTIME_PERMISSIONS.keys["entries.read_own"], TIMOTIME_PERMISSIONS.keys["entries.write_own"]],
    });
    const teamManagerRole = teamOrg.addRole({
      name: "Kierownik",
      product: "timotime",
      permissions: [TIMOTIME_PERMISSIONS.keys["entries.read"]],
    });

    const otherOrg = fakeCore.organization({ name: "Inna Firma", domain: "inna.test" });
    otherOrg.grantEntitlement("timotime");
    const otherEmpRole = otherOrg.addRole({
      name: "Pracownik",
      product: "timotime",
      permissions: [TIMOTIME_PERMISSIONS.keys["entries.read_own"], TIMOTIME_PERMISSIONS.keys["entries.write_own"]],
    });

    const jan = await signInEmployee(teamOrg, teamEmpRole.id, { firstName: "Jan", lastName: "Kierownik" });
    teamOrg.assignRole({
      accountId: jan.accountId,
      roleId: teamManagerRole.id,
      scope: { type: "UNIT", unitId: krakow.id },
    });

    const ownerRec = teamOrg.addEmployee({ firstName: "Ola", lastName: "Właścicielka", isOwner: true });
    const ownerToken = await teamOrg.signUserToken(ownerRec.accountId, { audience: API });

    const empAnna = await signInEmployee(teamOrg, teamEmpRole.id, {
      firstName: "Anna",
      lastName: "Nowak",
      unitIds: [krakowA.id],
    });
    const marek = await signInEmployee(teamOrg, teamEmpRole.id, {
      firstName: "Marek",
      lastName: "Kowalski",
      unitIds: [sales.id],
    });
    const piotr = await signInEmployee(teamOrg, teamEmpRole.id, {
      firstName: "Piotr",
      lastName: "Zieliński",
      unitIds: [warszawa.id],
    });
    const celina = await signInEmployee(otherOrg, otherEmpRole.id, { firstName: "Celina", lastName: "Obca" });

    // Wymuś stronicowanie katalogu po 1 elemencie na stronę
    directoryMaxLimit = 1;

    await call(start.POST, "/time/start", {
      method: "POST",
      token: empAnna.token,
      body: { kind: "WORK", note: "Kraków A" },
    });
    await call(start.POST, "/time/start", { method: "POST", token: marek.token, body: { kind: "REMOTE" } });
    await call(start.POST, "/time/start", { method: "POST", token: piotr.token, body: { kind: "WORK" } });
    await call(start.POST, "/time/start", { method: "POST", token: celina.token, body: { kind: "WORK" } });

    // Jan widzi Annę (podjednostka Zespół Kraków A) i Marka (Dział Sprzedaży), nie widzi Piotra ani Celiny
    const janCurrent = await call(teamCurrent.GET, "/team/current", { token: jan.token });
    expect(janCurrent.status).toBe(200);
    expect(janCurrent.body.data.entries).toHaveLength(2);
    expect(
      janCurrent.body.data.entries.map((item: { employee: { firstName: string; lastName: string } }) => item.employee),
    ).toEqual(
      expect.arrayContaining([
        { id: empAnna.employeeId, firstName: "Anna", lastName: "Nowak" },
        { id: marek.employeeId, firstName: "Marek", lastName: "Kowalski" },
      ]),
    );
    expect(fakeCore.calls.directoryUnitMembers).toBeGreaterThanOrEqual(2);
    expect(fakeCore.calls.directoryEmployees).toBeGreaterThanOrEqual(2);

    const janToday = await call(teamEntries.GET, "/team/entries", { token: jan.token });
    expect(janToday.status).toBe(200);
    expect(janToday.body.data.entries.map((item: { employeeId: string }) => item.employeeId).sort()).toEqual(
      [empAnna.employeeId, marek.employeeId].sort(),
    );

    // Owner (zakres ORGANIZATION) widzi wszystkich z firmy (Annę, Marka i Piotra), nigdy Celiny z innej firmy
    const ownerCurrent = await call(teamCurrent.GET, "/team/current", { token: ownerToken });
    expect(ownerCurrent.status).toBe(200);
    expect(ownerCurrent.body.data.entries.map((item: { employeeId: string }) => item.employeeId).sort()).toEqual(
      [empAnna.employeeId, marek.employeeId, piotr.employeeId].sort(),
    );
  });

  it("cache odświeża uprawnienia natychmiast po wzroście authz_rev w tokenie użytkownika", async () => {
    const newPerson = acme.addEmployee({ firstName: "Nowa", lastName: "Osoba", products: [] });
    const tokenRev0 = await acme.signUserToken(newPerson.accountId, { audience: API });
    const denied = await call(current.GET, "/time/current", { token: tokenRev0 });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("PRODUCT_ACCESS_REQUIRED");

    acme.grantAppAccess(newPerson.accountId, "timotime");
    acme.assignRole({ accountId: newPerson.accountId, roleId: employeeRoleId, scope: { type: "ORGANIZATION" } });
    const nextRev = acme.bumpAuthzRevision(newPerson.accountId);
    const tokenRev1 = await acme.signUserToken(newPerson.accountId, { audience: API, authzRevision: nextRev });

    const allowed = await call(current.GET, "/time/current", { token: tokenRev1 });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data).toBeNull();
  });
});
