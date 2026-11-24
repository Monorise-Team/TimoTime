/**
 * Testy API na prawdziwych trasach Next.js: lokalny serwer udający Core Auth + Core API
 * (`/api/auth/oauth2/token`, `/core/v1/me`, `/core/v1/products/timotime/permission-snapshot`,
 * `/core/v1/products/timotime/directory/*`), podpisane tokeny z testowego klucza „Core”
 * (`test/setup.ts`) i baza PostgreSQL z RLS.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Authenticated, Session } from "@monorise-team/auth/next";
import type { PermissionSnapshot } from "@monorise-team/permissions";
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
import { getDb } from "@/server/db";
import { invalidatePermissionCache, PRODUCT_ACCESS_REQUIRED_MESSAGE } from "@/server/permissions";
import { API, coreToken } from "./setup";

const BASE = "http://time.localhost:3300/api/v1";

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

const ACME = randomUUID();
const ANNA_ID = randomUUID();
const ANNA_EMPLOYEE_ID = randomUUID();

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

type FakeCoreMode = "ok" | "unauthorized" | "server-error";
let coreMode: FakeCoreMode = "ok";
let snapshotMode: "ok" | "server-error" = "ok";
let fakeCoreUrl = "";
let machineTokenCalls = 0;
let snapshotCalls = 0;
let unitMemberCalls = 0;
let employeeDirectoryCalls = 0;
let directoryPageSize = 100;

interface FakeUnitMember {
  organizationId: string;
  unitId: string;
  employeeId: string;
  accountId: string | null;
  role: "MEMBER" | "LEADER";
}

interface FakeDirectoryEmployee {
  organizationId: string;
  id: string;
  accountId: string | null;
  firstName: string;
  lastName: string;
  status: "ACTIVE" | "FORMER" | "ANONYMIZED";
}

let customSnapshots = new Map<string, PermissionSnapshot>();
let fakeUnitMembers: FakeUnitMember[] = [];
let fakeDirectoryEmployees: FakeDirectoryEmployee[] = [];

function defaultEmployeeSnapshot(organizationId: string, accountId: string): PermissionSnapshot {
  return {
    accountId,
    organizationId,
    authzRevision: 0,
    isOwner: false,
    products: ["timotime"],
    grants: [
      { permission: "timotime.entries.read_own", scope: { type: "ORGANIZATION" } },
      { permission: "timotime.entries.write_own", scope: { type: "ORGANIZATION" } },
    ],
    units: organizationId === ACME ? ACME_UNITS : [],
  };
}

const fakeCoreServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", fakeCoreUrl);

  if (url.pathname === "/api/auth/oauth2/token" && req.method === "POST") {
    machineTokenCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        access_token: `fake-machine-token-${machineTokenCalls}`,
        expires_in: 300,
        token_type: "Bearer",
      }),
    );
    return;
  }

  if (url.pathname === "/core/v1/me" && req.method === "GET") {
    if (!req.headers.authorization || coreMode === "unauthorized") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: null,
          meta: { requestId: "req_core_401" },
          error: { code: "UNAUTHENTICATED", message: "Invalid token", details: [] },
        }),
      );
      return;
    }
    if (coreMode === "server-error") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: null,
          meta: { requestId: "req_core_500" },
          error: { code: "INTERNAL", message: "Core failure", details: [] },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: {
          account: { id: ANNA_ID, email: "anna@acme.test", isOwner: false, status: "ACTIVE" },
          employee: {
            id: ANNA_EMPLOYEE_ID,
            firstName: "Anna",
            lastName: "Nowak",
            workEmail: "anna@acme.test",
            jobTitle: "Specjalistka logistyki",
            status: "ACTIVE",
          },
          organization: { id: ACME, name: "Acme", status: "ACTIVE" },
        },
        meta: { requestId: "req_core_ok" },
        error: null,
      }),
    );
    return;
  }

  if (url.pathname === "/core/v1/products/timotime/permission-snapshot" && req.method === "GET") {
    snapshotCalls += 1;
    if (!req.headers.authorization?.startsWith("Bearer fake-machine-token-")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: null,
          meta: { requestId: "req_snap_401" },
          error: { code: "UNAUTHENTICATED", message: "Missing machine token", details: [] },
        }),
      );
      return;
    }
    if (snapshotMode === "server-error") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: null,
          meta: { requestId: "req_snap_500" },
          error: { code: "INTERNAL", message: "Snapshot failure", details: [] },
        }),
      );
      return;
    }
    const organizationId = url.searchParams.get("organizationId") ?? "";
    const accountId = url.searchParams.get("accountId") ?? "";
    const snapshot = customSnapshots.get(accountId) ?? defaultEmployeeSnapshot(organizationId, accountId);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: snapshot, meta: { requestId: "req_snap_ok" }, error: null }));
    return;
  }

  if (url.pathname === "/core/v1/products/timotime/directory/unit-members" && req.method === "GET") {
    unitMemberCalls += 1;
    const organizationId = url.searchParams.get("organizationId") ?? "";
    const unitIds = url.searchParams.getAll("unitId");
    const matching = fakeUnitMembers
      .filter((m) => m.organizationId === organizationId && (unitIds.length === 0 || unitIds.includes(m.unitId)))
      .map(({ unitId, employeeId, accountId, role }) => ({ unitId, employeeId, accountId, role }));
    const offset = Number(url.searchParams.get("cursor") ?? "0");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), directoryPageSize);
    const items = matching.slice(offset, offset + limit);
    const nextCursor = offset + limit < matching.length ? String(offset + limit) : null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: items, meta: { requestId: "req_um_ok", nextCursor }, error: null }));
    return;
  }

  if (url.pathname === "/core/v1/products/timotime/directory/employees" && req.method === "GET") {
    employeeDirectoryCalls += 1;
    const organizationId = url.searchParams.get("organizationId") ?? "";
    const employeeIds = url.searchParams.getAll("employeeId");
    const matching = fakeDirectoryEmployees
      .filter((e) => e.organizationId === organizationId && (employeeIds.length === 0 || employeeIds.includes(e.id)))
      .map(({ id, accountId, firstName, lastName, status }) => ({ id, accountId, firstName, lastName, status }));
    const offset = Number(url.searchParams.get("cursor") ?? "0");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), directoryPageSize);
    const items = matching.slice(offset, offset + limit);
    const nextCursor = offset + limit < matching.length ? String(offset + limit) : null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: items, meta: { requestId: "req_emp_ok", nextCursor }, error: null }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      data: null,
      meta: { requestId: "req_core_404" },
      error: { code: "NOT_FOUND", message: "Not found", details: [] },
    }),
  );
});

beforeAll(async () => {
  await new Promise<void>((resolve) => fakeCoreServer.listen(0, "127.0.0.1", resolve));
  const address = fakeCoreServer.address() as AddressInfo;
  fakeCoreUrl = `http://127.0.0.1:${address.port}`;
  process.env.CORE_AUTH_URL = fakeCoreUrl;
  process.env.CORE_API_URL = fakeCoreUrl;
});

beforeEach(() => {
  coreMode = "ok";
  snapshotMode = "ok";
  machineTokenCalls = 0;
  snapshotCalls = 0;
  unitMemberCalls = 0;
  employeeDirectoryCalls = 0;
  directoryPageSize = 100;
  customSnapshots = new Map();
  fakeUnitMembers = [];
  fakeDirectoryEmployees = [];
  process.env.CORE_AUTH_URL = fakeCoreUrl;
  process.env.CORE_API_URL = fakeCoreUrl;
  invalidatePermissionCache();
  resetMachineCoreTokenCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await new Promise<void>((resolve) => fakeCoreServer.close(() => resolve()));
});

async function signIn(organizationId = ACME, accountId = randomUUID(), employeeId = randomUUID(), authzRevision = 0) {
  return {
    accountId,
    organizationId,
    employeeId,
    token: await coreToken({ accountId, organizationId, employeeId, authzRevision }),
  };
}

/** Sesja przeglądarki (BFF) udająca `getAuth().authenticate` z dostępem do tokenu Core API. */
function mockBrowserSession(coreAccessToken: string, authzRevision = 0) {
  const context = {
    accountId: ANNA_ID,
    organizationId: ACME,
    employeeId: ANNA_EMPLOYEE_ID,
    sessionId: "sesja-core",
    authzRevision,
    methods: [],
    clientId: "timotime-web",
    scopes: ["openid", "profile", "email", "offline_access"],
    expiresAt: new Date(Date.now() + 5 * 60_000),
  };
  const requestedResources: (string | undefined)[] = [];
  const session: Session = {
    context,
    profile: { email: "anna@acme.test", name: "Anna Nowak" },
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    accessToken: async (resource?: string) => {
      requestedResources.push(resource);
      return coreAccessToken;
    },
  };
  const authenticated: Authenticated = { context, via: "session", session };
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
    const coreApiToken = await coreToken({
      accountId: ANNA_ID,
      organizationId: ACME,
      employeeId: ANNA_EMPLOYEE_ID,
      audience: fakeCoreUrl,
    });
    const { requestedResources } = mockBrowserSession(coreApiToken);

    const { status, body } = await call(me.GET, "/me");
    expect(status).toBe(200);
    expect(requestedResources).toEqual([fakeCoreUrl]);
    expect(body.data).toMatchObject({
      account: { id: ANNA_ID, email: "anna@acme.test" },
      employee: { id: ANNA_EMPLOYEE_ID, firstName: "Anna", lastName: "Nowak", fullName: "Anna Nowak" },
      organization: { id: ACME, name: "Acme" },
      capabilities: { trackOwnTime: true, viewTeam: false },
    });

    // Po nadaniu roli Kierownik i podbiciu authz_rev pamięć podręczna odświeża capabilities
    customSnapshots.set(ANNA_ID, {
      accountId: ANNA_ID,
      organizationId: ACME,
      authzRevision: 1,
      isOwner: false,
      products: ["timotime"],
      grants: [
        { permission: "timotime.entries.read_own", scope: { type: "ORGANIZATION" } },
        { permission: "timotime.entries.write_own", scope: { type: "ORGANIZATION" } },
        { permission: "timotime.entries.read", scope: { type: "UNIT", unitId: UNIT_KRAKOW } },
      ],
      units: ACME_UNITS,
    });
    mockBrowserSession(coreApiToken, 1);
    const refreshed = await call(me.GET, "/me");
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.capabilities).toEqual({ trackOwnTime: true, viewTeam: true });
    expect(snapshotCalls).toBe(2);
    // Token maszynowy został pobrany raz i użyty ponownie z cache
    expect(machineTokenCalls).toBe(1);
  });

  it("GET /api/v1/me odrzuca token bearer z telefonu (403 PERMISSION_DENIED) zamiast przekazywać go do Core", async () => {
    const anna = await signIn(ACME, ANNA_ID, ANNA_EMPLOYEE_ID);
    const { status, body } = await call(me.GET, "/me", { token: anna.token });
    expect(status).toBe(403);
    expect(body.data).toBeNull();
    expect(body.error.code).toBe("PERMISSION_DENIED");
    expect(body.error.message).toMatch(/Core API/);
  });

  it("mapuje błędy Core API na 401 i 503 dla sesji BFF i niedostępności migawki", async () => {
    const coreApiToken = await coreToken({
      accountId: ANNA_ID,
      organizationId: ACME,
      employeeId: ANNA_EMPLOYEE_ID,
      audience: fakeCoreUrl,
    });
    mockBrowserSession(coreApiToken);

    coreMode = "unauthorized";
    const unauth = await call(me.GET, "/me");
    expect(unauth.status).toBe(401);
    expect(unauth.body.error.code).toBe("UNAUTHENTICATED");

    coreMode = "server-error";
    const failed = await call(me.GET, "/me");
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe("INTERNAL");

    coreMode = "ok";
    snapshotMode = "server-error";
    const snapFailed = await call(me.GET, "/me");
    expect(snapFailed.status).toBe(503);
    expect(snapFailed.body.error.code).toBe("INTERNAL");

    snapshotMode = "ok";
    process.env.CORE_API_URL = "http://127.0.0.1:1";
    const unavailable = await call(me.GET, "/me");
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error.code).toBe("INTERNAL");
  });

  it("migawka bez produktu timotime zwraca 403 z polskim komunikatem na własnych wpisach i widoku zespołu", async () => {
    const blocked = await signIn(ACME);
    customSnapshots.set(blocked.accountId, {
      accountId: blocked.accountId,
      organizationId: ACME,
      authzRevision: 0,
      isOwner: false,
      products: [],
      grants: [],
      units: ACME_UNITS,
    });

    for (const res of [
      await call(current.GET, "/time/current", { token: blocked.token }),
      await call(entries.GET, "/time/entries", { token: blocked.token }),
      await call(start.POST, "/time/start", { method: "POST", token: blocked.token, body: { kind: "WORK" } }),
      await call(teamCurrent.GET, "/team/current", { token: blocked.token }),
      await call(teamEntries.GET, "/team/entries", { token: blocked.token }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("PERMISSION_DENIED");
      expect(res.body.error.message).toBe(PRODUCT_ACCESS_REQUIRED_MESSAGE);
    }
  });

  it("pracownik bez timotime.entries.read dostaje 403 na trasach zespołu", async () => {
    const anna = await signIn(ACME);
    const cur = await call(teamCurrent.GET, "/team/current", { token: anna.token });
    expect(cur.status).toBe(403);
    expect(cur.body.error.code).toBe("PERMISSION_DENIED");

    const list = await call(teamEntries.GET, "/team/entries", { token: anna.token });
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe("PERMISSION_DENIED");
  });

  it("odrzuca token dla innego API i token po terminie", async () => {
    const accountId = randomUUID();
    const otherApi = await coreToken({ accountId, organizationId: ACME, audience: "http://localhost:3200" });
    expect((await call(me.GET, "/me", { token: otherApi })).status).toBe(401);
    const expired = await coreToken({ accountId, organizationId: ACME, expiresIn: "-1m" });
    expect((await call(me.GET, "/me", { token: expired })).body.error.code).toBe("UNAUTHENTICATED");
  });

  it("logowanie w przeglądarce przekierowuje do Core z PKCE i oboma API", async () => {
    const response = await signInRoute.GET(new Request("http://timo-time.localhost:3300/api/auth/sign-in?returnTo=/"));
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("location") ?? "");
    expect(`${target.origin}${target.pathname}`).toBe(`${fakeCoreUrl}/api/auth/oauth2/authorize`);
    expect(target.searchParams.get("client_id")).toBe("timotime-web");
    expect(target.searchParams.get("redirect_uri")).toBe("http://timo-time.localhost:3300/api/auth/callback");
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(target.searchParams.getAll("resource")).toEqual([API, fakeCoreUrl]);
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
    const anna = await signIn();
    const badKind = await call(start.POST, "/time/start", {
      method: "POST",
      token: anna.token,
      body: { kind: "INVALID_KIND" },
    });
    expect(badKind.status).toBe(422);
    expect(badKind.body.error.code).toBe("VALIDATION_FAILED");
    expect(badKind.body.error.details.map((d: { field: string }) => d.field)).toContain("kind");

    const tooLong = await call(entries.GET, "/time/entries?from=2026-10-01&to=2026-11-15", { token: anna.token });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.error.code).toBe("VALIDATION_FAILED");

    const reversed = await call(entries.GET, "/time/entries?from=2026-11-24&to=2026-11-20", { token: anna.token });
    expect(reversed.status).toBe(422);
    expect(reversed.body.error.code).toBe("VALIDATION_FAILED");

    const teamTooLong = await call(teamEntries.GET, "/team/entries?from=2026-10-01&to=2026-11-15", {
      token: anna.token,
    });
    expect(teamTooLong.status).toBe(422);
    expect(teamTooLong.body.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("API: rejestracja czasu pracy i widok zespołu (PostgreSQL z RLS)", () => {
  it("przełącza statusy praca -> przerwa -> praca, zamyka wpis i listuje dzisiejsze wpisy", async () => {
    const anna = await signIn();

    const empty = await call(current.GET, "/time/current", { token: anna.token });
    expect(empty.status).toBe(200);
    expect(empty.body.data).toBeNull();

    const stopEmpty = await call(stop.POST, "/time/stop", { method: "POST", token: anna.token });
    expect(stopEmpty.status).toBe(409);
    expect(stopEmpty.body.error.code).toBe("CONFLICT");

    const work1 = await call(start.POST, "/time/start", {
      method: "POST",
      token: anna.token,
      body: { kind: "WORK", note: "Start zmiany" },
    });
    expect(work1.status).toBe(201);
    expect(work1.body.data).toMatchObject({
      kind: "WORK",
      endedAt: null,
      note: "Start zmiany",
      accountId: anna.accountId,
      organizationId: anna.organizationId,
    });

    const active1 = await call(current.GET, "/time/current", { token: anna.token });
    expect(active1.body.data.id).toBe(work1.body.data.id);

    const brk = await call(start.POST, "/time/start", {
      method: "POST",
      token: anna.token,
      body: { kind: "BREAK" },
    });
    expect(brk.status).toBe(201);
    expect(brk.body.data).toMatchObject({ kind: "BREAK", endedAt: null });

    const work2 = await call(start.POST, "/time/start", {
      method: "POST",
      token: anna.token,
      body: { kind: "REMOTE" },
    });
    expect(work2.status).toBe(201);
    expect(work2.body.data).toMatchObject({ kind: "REMOTE", endedAt: null });

    const stopped = await call(stop.POST, "/time/stop", { method: "POST", token: anna.token });
    expect(stopped.status).toBe(200);
    expect(stopped.body.data.id).toBe(work2.body.data.id);
    expect(stopped.body.data.endedAt).not.toBeNull();

    const afterStop = await call(current.GET, "/time/current", { token: anna.token });
    expect(afterStop.body.data).toBeNull();

    const list = await call(entries.GET, "/time/entries", { token: anna.token });
    expect(list.status).toBe(200);
    expect(list.body.data.entries).toHaveLength(3);
    expect(list.body.data.entries.map((item: { kind: string }) => item.kind)).toEqual(["REMOTE", "BREAK", "WORK"]);
    for (const item of list.body.data.entries as { endedAt: string | null }[]) {
      expect(item.endedAt).not.toBeNull();
    }
  });

  it("zwraca 409 CONFLICT przy dwóch równoczesnych wywołaniach start i zostawia jeden otwarty wpis", async () => {
    const anna = await signIn();
    // Rozgrzanie dwóch połączeń z puli przed równoczesnym startem
    const warmup = await Promise.all([
      call(current.GET, "/time/current", { token: anna.token }),
      call(current.GET, "/time/current", { token: anna.token }),
    ]);
    expect(warmup.map((item) => item.body.data)).toEqual([null, null]);

    const results = await Promise.all([
      call(start.POST, "/time/start", { method: "POST", token: anna.token, body: { kind: "WORK" } }),
      call(start.POST, "/time/start", { method: "POST", token: anna.token, body: { kind: "WORK" } }),
    ]);
    const statuses = results.map((result) => result.status).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    const conflict = results.find((result) => result.status === 409);
    expect(conflict?.body.error.code).toBe("CONFLICT");
    expect(conflict?.body.error.message).toBe("Masz już otwarty wpis");

    const openEntries = await withUser(
      getDb(),
      { organizationId: anna.organizationId, accountId: anna.accountId },
      (tx) => tx.timeEntry.findMany({ where: { endedAt: null } }),
    );
    expect(openEntries).toHaveLength(1);
  });

  it("GET /api/v1/time/entries uwzględnia wpisy nakładające się na zakres (np. praca nocna 22:00-02:00)", async () => {
    const anna = await signIn();
    const actor = { organizationId: anna.organizationId, accountId: anna.accountId };
    const earlierId = uuidv7(Date.parse("2026-11-23T08:00:00.000Z"));
    const overnightId = uuidv7(Date.parse("2026-11-23T22:00:00.000Z"));
    const daytimeId = uuidv7(Date.parse("2026-11-24T09:00:00.000Z"));
    const openBeforeRangeId = uuidv7(Date.parse("2026-11-24T22:00:00.000Z"));

    await withUser(getDb(), actor, async (tx) => {
      await tx.timeEntry.createMany({
        data: [
          {
            id: earlierId,
            organizationId: anna.organizationId,
            accountId: anna.accountId,
            employeeId: anna.employeeId,
            kind: "WORK",
            startedAt: new Date("2026-11-23T08:00:00.000Z"),
            endedAt: new Date("2026-11-23T16:00:00.000Z"),
          },
          {
            id: overnightId,
            organizationId: anna.organizationId,
            accountId: anna.accountId,
            employeeId: anna.employeeId,
            kind: "WORK",
            startedAt: new Date("2026-11-23T22:00:00.000Z"),
            endedAt: new Date("2026-11-24T02:00:00.000Z"),
          },
          {
            id: daytimeId,
            organizationId: anna.organizationId,
            accountId: anna.accountId,
            employeeId: anna.employeeId,
            kind: "REMOTE",
            startedAt: new Date("2026-11-24T09:00:00.000Z"),
            endedAt: new Date("2026-11-24T12:00:00.000Z"),
          },
          {
            id: openBeforeRangeId,
            organizationId: anna.organizationId,
            accountId: anna.accountId,
            employeeId: anna.employeeId,
            kind: "WORK",
            startedAt: new Date("2026-11-24T22:00:00.000Z"),
            endedAt: null,
          },
        ],
      });
    });

    const day24 = await call(entries.GET, "/time/entries?from=2026-11-24&to=2026-11-24", { token: anna.token });
    expect(day24.status).toBe(200);
    expect(day24.body.data.entries.map((item: { id: string }) => item.id)).toEqual([
      openBeforeRangeId,
      daytimeId,
      overnightId,
    ]);

    const day25 = await call(entries.GET, "/time/entries?from=2026-11-25&to=2026-11-25", { token: anna.token });
    expect(day25.status).toBe(200);
    expect(day25.body.data.entries.map((item: { id: string }) => item.id)).toEqual([openBeforeRangeId]);
  });

  it("osoba z innej firmy ani współpracownik nie widzi i nie zamknie cudzego wpisu", async () => {
    const anna = await signIn(ACME);
    const bartek = await signIn(ACME);
    const celina = await signIn(randomUUID());

    const started = await call(start.POST, "/time/start", {
      method: "POST",
      token: anna.token,
      body: { kind: "WORK" },
    });
    expect(started.status).toBe(201);

    for (const other of [bartek, celina]) {
      expect((await call(current.GET, "/time/current", { token: other.token })).body.data).toBeNull();
      expect((await call(entries.GET, "/time/entries", { token: other.token })).body.data.entries).toEqual([]);
      expect((await call(stop.POST, "/time/stop", { method: "POST", token: other.token })).status).toBe(409);
    }

    expect((await call(current.GET, "/time/current", { token: anna.token })).body.data.id).toBe(started.body.data.id);
  });

  it("Jan (UNIT Kraków) widzi Annę i Marka z podjednostek Krakowa, a nie Piotra (Warszawa) ani Celiny (inna firma); ORGANIZATION widzi całą firmę", async () => {
    const teamOrg = randomUUID();
    const otherOrg = randomUUID();
    const krakow = randomUUID();
    const sales = randomUUID();
    const krakowA = randomUUID();
    const warszawa = randomUUID();
    const orgUnits = [
      { id: krakow, parentId: null },
      { id: sales, parentId: krakow },
      { id: krakowA, parentId: sales },
      { id: warszawa, parentId: null },
    ];

    const jan = await signIn(teamOrg);
    const owner = await signIn(teamOrg);
    const anna = await signIn(teamOrg);
    const marek = await signIn(teamOrg);
    const piotr = await signIn(teamOrg);
    const celina = await signIn(otherOrg);

    customSnapshots.set(jan.accountId, {
      accountId: jan.accountId,
      organizationId: teamOrg,
      authzRevision: 0,
      isOwner: false,
      products: ["timotime"],
      grants: [
        { permission: "timotime.entries.read_own", scope: { type: "ORGANIZATION" } },
        { permission: "timotime.entries.write_own", scope: { type: "ORGANIZATION" } },
        { permission: "timotime.entries.read", scope: { type: "UNIT", unitId: krakow } },
      ],
      units: orgUnits,
    });
    customSnapshots.set(owner.accountId, {
      accountId: owner.accountId,
      organizationId: teamOrg,
      authzRevision: 0,
      isOwner: true,
      products: ["timotime"],
      grants: [],
      units: orgUnits,
    });

    fakeUnitMembers = [
      {
        organizationId: teamOrg,
        unitId: krakowA,
        employeeId: anna.employeeId,
        accountId: anna.accountId,
        role: "MEMBER",
      },
      {
        organizationId: teamOrg,
        unitId: sales,
        employeeId: marek.employeeId,
        accountId: marek.accountId,
        role: "MEMBER",
      },
      {
        organizationId: teamOrg,
        unitId: warszawa,
        employeeId: piotr.employeeId,
        accountId: piotr.accountId,
        role: "MEMBER",
      },
    ];
    fakeDirectoryEmployees = [
      {
        organizationId: teamOrg,
        id: anna.employeeId,
        accountId: anna.accountId,
        firstName: "Anna",
        lastName: "Nowak",
        status: "ACTIVE",
      },
      {
        organizationId: teamOrg,
        id: marek.employeeId,
        accountId: marek.accountId,
        firstName: "Marek",
        lastName: "Kowalski",
        status: "ACTIVE",
      },
      {
        organizationId: teamOrg,
        id: piotr.employeeId,
        accountId: piotr.accountId,
        firstName: "Piotr",
        lastName: "Zieliński",
        status: "ACTIVE",
      },
      {
        organizationId: otherOrg,
        id: celina.employeeId,
        accountId: celina.accountId,
        firstName: "Celina",
        lastName: "Obca",
        status: "ACTIVE",
      },
    ];

    // Wymuś stronicowanie katalogu po 1 elemencie na stronę
    directoryPageSize = 1;

    await call(start.POST, "/time/start", {
      method: "POST",
      token: anna.token,
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
        { id: anna.employeeId, firstName: "Anna", lastName: "Nowak" },
        { id: marek.employeeId, firstName: "Marek", lastName: "Kowalski" },
      ]),
    );
    expect(unitMemberCalls).toBeGreaterThanOrEqual(2);
    expect(employeeDirectoryCalls).toBeGreaterThanOrEqual(2);

    const janToday = await call(teamEntries.GET, "/team/entries", { token: jan.token });
    expect(janToday.status).toBe(200);
    expect(janToday.body.data.entries.map((item: { employeeId: string }) => item.employeeId).sort()).toEqual(
      [anna.employeeId, marek.employeeId].sort(),
    );

    // Owner (zakres ORGANIZATION) widzi wszystkich z firmy (Annę, Marka i Piotra), nigdy Celiny z innej firmy
    const ownerCurrent = await call(teamCurrent.GET, "/team/current", { token: owner.token });
    expect(ownerCurrent.status).toBe(200);
    expect(ownerCurrent.body.data.entries.map((item: { employeeId: string }) => item.employeeId).sort()).toEqual(
      [anna.employeeId, marek.employeeId, piotr.employeeId].sort(),
    );
  });

  it("cache odświeża uprawnienia natychmiast po wzroście authz_rev w tokenie użytkownika", async () => {
    const accountId = randomUUID();
    const employeeId = randomUUID();
    customSnapshots.set(accountId, {
      accountId,
      organizationId: ACME,
      authzRevision: 0,
      isOwner: false,
      products: [],
      grants: [],
      units: ACME_UNITS,
    });

    const tokenRev0 = await coreToken({ accountId, organizationId: ACME, employeeId, authzRevision: 0 });
    expect((await call(current.GET, "/time/current", { token: tokenRev0 })).status).toBe(403);

    customSnapshots.set(accountId, {
      accountId,
      organizationId: ACME,
      authzRevision: 1,
      isOwner: false,
      products: ["timotime"],
      grants: [{ permission: "timotime.entries.read_own", scope: { type: "ORGANIZATION" } }],
      units: ACME_UNITS,
    });
    const tokenRev1 = await coreToken({ accountId, organizationId: ACME, employeeId, authzRevision: 1 });
    const allowed = await call(current.GET, "/time/current", { token: tokenRev1 });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data).toBeNull();
  });
});
