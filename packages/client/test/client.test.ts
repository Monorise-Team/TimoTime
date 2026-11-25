import { describe, expect, it } from "vitest";
import { ApiError, createClient } from "../src/index.js";

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}) {
  return (async (url: string, init?: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("klient API TimoTime", () => {
  it("dokleja /api/v1, token aplikacji i parametry zakresu dat", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const client = createClient({
      baseUrl: "https://time.monorise.studio",
      getToken: () => "tajny-token",
      fetch: fakeFetch(
        200,
        {
          data: { entries: [], from: "2026-11-24T00:00:00.000Z", to: "2026-11-24T23:59:59.999Z" },
          meta: {},
          error: null,
        },
        seen,
      ),
    });
    const list = await client.time.entries({ from: "2026-11-24", to: "2026-11-24" });
    expect(list.entries).toEqual([]);
    expect(seen.url).toBe("https://time.monorise.studio/api/v1/time/entries?from=2026-11-24&to=2026-11-24");
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe("Bearer tajny-token");
    expect(seen.init?.credentials).toBe("omit");
  });

  it("w przeglądarce używa ciasteczka zamiast tokenu", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const client = createClient({ fetch: fakeFetch(200, { data: null, meta: {}, error: null }, seen) });
    expect(await client.time.current()).toBeNull();
    expect(seen.init?.credentials).toBe("same-origin");
    expect((seen.init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("zamienia błąd API na ApiError z kodem", async () => {
    const client = createClient({
      fetch: fakeFetch(409, {
        data: null,
        meta: {},
        error: { code: "CONFLICT", message: "Brak otwartego wpisu", details: [] },
      }),
    });
    const error = await client.time.stop().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "CONFLICT", status: 409 });

    const productDeniedClient = createClient({
      fetch: fakeFetch(403, {
        data: null,
        meta: { requestId: "req_123" },
        error: {
          code: "PRODUCT_ACCESS_REQUIRED",
          message: "TimoTime nie jest włączony dla Twojego konta. Poproś Ownera firmy o dostęp.",
          details: [],
        },
      }),
    });
    const denied = await productDeniedClient.time.current().catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(ApiError);
    expect(denied).toMatchObject({ code: "PRODUCT_ACCESS_REQUIRED", status: 403 });
  });

  it("pobiera bieżący status i wpisy zespołu", async () => {
    const seenCurrent: { url?: string; init?: RequestInit } = {};
    const currentClient = createClient({
      baseUrl: "https://time.monorise.studio",
      fetch: fakeFetch(200, { data: { entries: [] }, meta: {}, error: null }, seenCurrent),
    });
    expect(await currentClient.team.current()).toEqual({ entries: [] });
    expect(seenCurrent.url).toBe("https://time.monorise.studio/api/v1/team/current");

    const seenEntries: { url?: string; init?: RequestInit } = {};
    const entriesClient = createClient({
      baseUrl: "https://time.monorise.studio",
      fetch: fakeFetch(
        200,
        {
          data: { entries: [], from: "2026-11-24T00:00:00.000Z", to: "2026-11-24T23:59:59.999Z" },
          meta: {},
          error: null,
        },
        seenEntries,
      ),
    });
    expect((await entriesClient.team.entries({ from: "2026-11-24", to: "2026-11-24" })).entries).toEqual([]);
    expect(seenEntries.url).toBe("https://time.monorise.studio/api/v1/team/entries?from=2026-11-24&to=2026-11-24");
  });
});
