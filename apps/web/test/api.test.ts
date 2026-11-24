/**
 * Testy API na prawdziwych trasach Next.js: lokalny serwer udający Core API (`/core/v1/me`),
 * podpisane tokeny z testowego klucza „Core” (`test/setup.ts`) i baza PostgreSQL z RLS.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Authenticated, Session } from "@monorise-team/auth/next";
import { uuidv7, withUser } from "@timotime/db";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as signInRoute from "@/app/api/auth/sign-in/route";
import * as health from "@/app/api/v1/health/route";
import * as me from "@/app/api/v1/me/route";
import * as current from "@/app/api/v1/time/current/route";
import * as entries from "@/app/api/v1/time/entries/route";
import * as start from "@/app/api/v1/time/start/route";
import * as stop from "@/app/api/v1/time/stop/route";
import { getAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { API, CORE, coreToken } from "./setup";

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

type FakeCoreMode = "ok" | "unauthorized" | "server-error";
let coreMode: FakeCoreMode = "ok";
let fakeCoreUrl = "";
const fakeCoreServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === "/core/v1/me" && req.method === "GET") {
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
          account: { id: ANNA_ID, email: "anna@acme.test", status: "ACTIVE" },
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
  process.env.CORE_API_URL = fakeCoreUrl;
});

beforeEach(() => {
  coreMode = "ok";
  process.env.CORE_API_URL = fakeCoreUrl;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await new Promise<void>((resolve) => fakeCoreServer.close(() => resolve()));
});

async function signIn(organizationId = ACME, accountId = randomUUID(), employeeId = randomUUID()) {
  return {
    accountId,
    organizationId,
    employeeId,
    token: await coreToken({ accountId, organizationId, employeeId }),
  };
}

/** Sesja przeglądarki (BFF) udająca `getAuth().authenticate` z dostępem do tokenu Core API. */
function mockBrowserSession(coreAccessToken: string) {
  const context = {
    accountId: ANNA_ID,
    organizationId: ACME,
    employeeId: ANNA_EMPLOYEE_ID,
    sessionId: "sesja-core",
    authzRevision: 0,
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

describe("API: sesja, Core SDK i walidacja", () => {
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

  it("GET /api/v1/me z sesją przeglądarki (BFF) pobiera osobę i firmę z Core przez @monorise-team/sdk", async () => {
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
    });
  });

  it("GET /api/v1/me odrzuca token bearer z telefonu (403 PERMISSION_DENIED) zamiast przekazywać go do Core", async () => {
    const anna = await signIn(ACME, ANNA_ID, ANNA_EMPLOYEE_ID);
    const { status, body } = await call(me.GET, "/me", { token: anna.token });
    expect(status).toBe(403);
    expect(body.data).toBeNull();
    expect(body.error.code).toBe("PERMISSION_DENIED");
    expect(body.error.message).toMatch(/Core API/);
  });

  it("mapuje błędy Core API na 401 i 503 dla sesji BFF", async () => {
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

    process.env.CORE_API_URL = "http://127.0.0.1:1";
    const unavailable = await call(me.GET, "/me");
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error.code).toBe("INTERNAL");
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
    expect(`${target.origin}${target.pathname}`).toBe(`${CORE}/api/auth/oauth2/authorize`);
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

  it("waliduje rodzaj wpisu i zakres dat (maksymalnie 31 dni)", async () => {
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
  });
});

describe("API: rejestracja czasu pracy (PostgreSQL z RLS)", () => {
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
});
