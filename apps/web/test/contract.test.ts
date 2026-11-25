/**
 * Testy zgodności TimoTime z kontraktem produktu Monorise (ADR-0046, ADR-0075) za pomocą
 * `defineProductContractTests` z `@monorise-team/testing` oraz kontrola spójności opisu OpenAPI 3.1.
 *
 * Testy działają bez bazy PostgreSQL i bez gniazd TCP (atrapa `createFakeCore` podpięta pod
 * `globalThis.fetch`; wszystkie odmowy uwierzytelnienia, dostępu do produktu i uprawnień
 * kończą się przed warstwą bazy danych).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createFakeCore, defineProductContractTests, type FakeCore } from "@monorise-team/testing";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as health from "@/app/api/v1/health/route";
import * as me from "@/app/api/v1/me/route";
import * as teamCurrent from "@/app/api/v1/team/current/route";
import * as teamEntries from "@/app/api/v1/team/entries/route";
import * as current from "@/app/api/v1/time/current/route";
import * as entries from "@/app/api/v1/time/entries/route";
import * as start from "@/app/api/v1/time/start/route";
import * as stop from "@/app/api/v1/time/stop/route";
import { resetMachineCoreTokenCache } from "@/server/core";
import { buildOpenApiDocument, serializeOpenApiDocument } from "@/server/openapi";
import { invalidatePermissionCache } from "@/server/permissions";
import { ROUTE_LIST } from "@/server/routes";

const API = "http://time.localhost:3300";
const FAKE_CORE_URL = "http://core.contract.test";
const CLIENT_ID = "timotime-web";
const CLIENT_SECRET = "sekret-klienta-tylko-do-testow";
const API_ROUTES_DIR = resolve(import.meta.dirname, "../src/app/api/v1");
const COMMITTED_OPENAPI_PATH = resolve(import.meta.dirname, "../../../openapi/timotime-api.json");

type NextRouteHandler = (
  request: NextRequest,
  context: { params: Promise<Record<string, never>> },
) => Promise<Response>;

const ROUTE_HANDLERS: Readonly<Record<string, NextRouteHandler>> = {
  "GET /api/v1/health": health.GET,
  "GET /api/v1/me": me.GET,
  "GET /api/v1/time/current": current.GET,
  "POST /api/v1/time/start": start.POST,
  "POST /api/v1/time/stop": stop.POST,
  "GET /api/v1/time/entries": entries.GET,
  "GET /api/v1/team/current": teamCurrent.GET,
  "GET /api/v1/team/entries": teamEntries.GET,
};

async function dispatchNextRoute(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const key = `${request.method.toUpperCase()} ${url.pathname}`;
  const handler = ROUTE_HANDLERS[key];
  if (!handler) {
    return new Response(
      JSON.stringify({
        data: null,
        meta: { requestId: "req_dispatch_404" },
        error: { code: "NOT_FOUND", message: `Nieznana trasa API: ${key}`, details: [] },
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }

  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
  const nextRequest = new NextRequest(request.url, {
    method: request.method,
    headers: request.headers,
    ...(body !== undefined && body.length > 0 ? { body } : {}),
  });
  return handler(nextRequest, { params: Promise.resolve({}) });
}

function listRoutePathsOnDisk(dir: string, prefix = "/api/v1"): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...listRoutePathsOnDisk(full, `${prefix}/${entry.name}`));
    } else if (entry.isFile() && entry.name === "route.ts") {
      paths.push(prefix);
    }
  }
  return paths.sort();
}

function collectSchemaRefs(value: unknown, refs: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaRefs(item, refs);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ref" && typeof entry === "string") {
      refs.add(entry);
    } else {
      collectSchemaRefs(entry, refs);
    }
  }
}

let fakeCore: FakeCore;

beforeAll(async () => {
  fakeCore = await createFakeCore({
    issuer: FAKE_CORE_URL,
    coreApiUrl: FAKE_CORE_URL,
    products: [{ key: "timotime", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }],
  });
  process.env.CORE_AUTH_URL = FAKE_CORE_URL;
  process.env.CORE_API_URL = FAKE_CORE_URL;
  delete process.env.TIMOTIME_CORE_JWKS;
  vi.spyOn(globalThis, "fetch").mockImplementation(fakeCore.fetch as typeof fetch);
});

beforeEach(() => {
  process.env.CORE_AUTH_URL = FAKE_CORE_URL;
  process.env.CORE_API_URL = FAKE_CORE_URL;
  invalidatePermissionCache();
  resetMachineCoreTokenCache();
});

afterAll(() => {
  vi.restoreAllMocks();
});

await defineProductContractTests({
  productKey: "timotime",
  baseUrl: API,
  audience: API,
  fakeCore: () => fakeCore,
  handler: dispatchNextRoute,
  routes: [
    { method: "GET", path: "/api/v1/time/current" },
    { method: "POST", path: "/api/v1/time/start", body: { kind: "WORK" } },
    { method: "POST", path: "/api/v1/time/stop", body: {} },
    { method: "GET", path: "/api/v1/time/entries" },
    { method: "GET", path: "/api/v1/team/current" },
    { method: "GET", path: "/api/v1/team/entries" },
    // Trasa BFF `/me` zwraca profil i capabilities nawet przed włączeniem TimoTime i nie wymaga osobnego uprawnienia
    { method: "GET", path: "/api/v1/me", skipPermissionCheck: true, skipProductAccessCheck: true },
  ],
  openApi: () => buildOpenApiDocument(),
});

describe("OpenAPI TimoTime API", () => {
  it("pokrywa dokładnie wszystkie pliki route.ts pod /api/v1 i wszystkie trasy w katalogu", () => {
    const document = buildOpenApiDocument();
    const diskPaths = listRoutePathsOnDisk(API_ROUTES_DIR);
    const openApiPaths = Object.keys(document.paths).sort();
    expect(openApiPaths).toEqual(diskPaths);

    const catalogOps = ROUTE_LIST.map((route) => `${route.method} ${route.path}`).sort();
    const dispatchedOps = Object.keys(ROUTE_HANDLERS).sort();
    expect(catalogOps).toEqual(dispatchedOps);
  });

  it("deklaruje schematy bezpieczeństwa bearerAuth i sessionCookie oraz zapytania zakresowe entries", () => {
    const document = buildOpenApiDocument();
    expect(Object.keys(document.components.securitySchemes).sort()).toEqual(["bearerAuth", "sessionCookie"]);
    expect(document.paths["/api/v1/health"]?.get?.security).toBeUndefined();
    expect(document.paths["/api/v1/me"]?.get?.security).toEqual([{ sessionCookie: [] }]);
    expect(document.paths["/api/v1/time/current"]?.get?.security).toEqual([{ bearerAuth: [] }, { sessionCookie: [] }]);

    for (const rangePath of ["/api/v1/time/entries", "/api/v1/team/entries"]) {
      const paramNames = (document.paths[rangePath]?.get?.parameters ?? []).map((p) => p.name);
      expect(paramNames).toEqual(["from", "to"]);
    }
  });

  it("nie ma zerwanych ani nieużywanych schematów w components.schemas i zgadza się z openapi/timotime-api.json", () => {
    const document = buildOpenApiDocument();
    const schemaNames = new Set(Object.keys(document.components.schemas));
    const usedRefs = new Set<string>();
    collectSchemaRefs(document.paths, usedRefs);
    collectSchemaRefs(document.components.schemas, usedRefs);

    for (const ref of usedRefs) {
      expect(ref.startsWith("#/components/schemas/")).toBe(true);
      expect(schemaNames.has(ref.slice("#/components/schemas/".length)), `Brakujący schemat ${ref}`).toBe(true);
    }
    for (const name of schemaNames) {
      expect(usedRefs.has(`#/components/schemas/${name}`), `Nieużywany schemat ${name}`).toBe(true);
    }

    const committed = readFileSync(COMMITTED_OPENAPI_PATH, "utf8");
    expect(JSON.parse(committed)).toEqual(document);
    expect(committed).toBe(serializeOpenApiDocument(document));
    expect(serializeOpenApiDocument(buildOpenApiDocument())).toBe(committed);
  });
});
