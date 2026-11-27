import { describe, expect, it, vi } from "vitest";
import {
  CORE_MACHINE_SCOPES,
  CoreMachineTokenError,
  createMachineTokenProvider,
  requestMachineToken,
} from "@/server/core-machine";

const BASE_CONFIG = {
  coreAuthUrl: "http://core-auth.test/",
  coreApiUrl: "http://core-api.test/",
  clientId: "timotime-web",
  clientSecret: "tajny-sekret-maszynowy-test",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("token maszynowy MonoriseCore (core-machine)", () => {
  it("pobiera token z zakresem core:permissions.read core:directory.read core:events.read core:notifications.send i cachuje go do 30 s przed wygaśnięciem", async () => {
    let clock = 1_000_000;
    let issued = 0;
    const seenBodies: URLSearchParams[] = [];

    const fakeFetch: typeof fetch = vi.fn(async (_input, init) => {
      seenBodies.push(new URLSearchParams(typeof init?.body === "string" ? init.body : ""));
      issued += 1;
      return jsonResponse({ access_token: `machine-token-${issued}`, expires_in: 300, token_type: "Bearer" });
    });

    const provider = createMachineTokenProvider({
      getConfig: () => BASE_CONFIG,
      scope: CORE_MACHINE_SCOPES,
      fetch: fakeFetch,
      now: () => clock,
    });

    // Pierwsze wywołanie pobiera token
    expect(await provider.getAccessToken()).toBe("machine-token-1");
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(seenBodies[0]?.get("grant_type")).toBe("client_credentials");
    expect(seenBodies[0]?.get("client_id")).toBe("timotime-web");
    expect(seenBodies[0]?.get("client_secret")).toBe(BASE_CONFIG.clientSecret);
    expect(seenBodies[0]?.get("resource")).toBe("http://core-api.test");
    expect(seenBodies[0]?.get("scope")).toBe(
      "core:permissions.read core:directory.read core:events.read core:notifications.send",
    );

    // 269 s później nadal w pamięci podręcznej (zostało > 30 s)
    clock += 269_000;
    expect(await provider.getAccessToken()).toBe("machine-token-1");
    expect(fakeFetch).toHaveBeenCalledTimes(1);

    // 270 s później (dokładnie 30 s przed wygaśnięciem) odświeża token
    clock += 1_000;
    expect(await provider.getAccessToken()).toBe("machine-token-2");
    expect(fakeFetch).toHaveBeenCalledTimes(2);

    // Ponowne wywołanie zaraz po odświeżeniu korzysta z nowego tokenu w cache
    clock += 5_000;
    expect(await provider.getAccessToken()).toBe("machine-token-2");
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it("łączy równoczesne odświeżenia w jedno żądanie OAuth (single-flight)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fakeFetch: typeof fetch = vi.fn(async () => {
      await gate;
      return jsonResponse({ access_token: "single-flight-token", expires_in: 300 });
    });

    const provider = createMachineTokenProvider({
      getConfig: () => BASE_CONFIG,
      scope: CORE_MACHINE_SCOPES,
      fetch: fakeFetch,
    });

    const pending = Promise.all([provider.getAccessToken(), provider.getAccessToken(), provider.getAccessToken()]);
    release();

    expect(await pending).toEqual(["single-flight-token", "single-flight-token", "single-flight-token"]);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("clear() unieważnia pamięć podręczną i zapobiega zapisaniu przestarzałego odświeżenia w locie", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let callCount = 0;

    const fakeFetch: typeof fetch = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        await firstGate;
        return jsonResponse({ access_token: "stary-token", expires_in: 300 });
      }
      return jsonResponse({ access_token: "swiezy-token", expires_in: 300 });
    });

    const provider = createMachineTokenProvider({
      getConfig: () => BASE_CONFIG,
      scope: CORE_MACHINE_SCOPES,
      fetch: fakeFetch,
    });

    const first = provider.getAccessToken();
    provider.clear();
    const second = provider.getAccessToken();
    releaseFirst();

    expect(await first).toBe("stary-token");
    expect(await second).toBe("swiezy-token");
    // W pamięci podręcznej został świeży token, nie stary
    expect(await provider.getAccessToken()).toBe("swiezy-token");
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it("nigdy nie ujawnia sekretu klienta ani tokenu w komunikatach błędów", async () => {
    const fakeFetch: typeof fetch = vi.fn(async () =>
      jsonResponse({ error: "invalid_client", error_description: "Odrzucono" }, 401),
    );

    const error = await requestMachineToken({
      ...BASE_CONFIG,
      scope: CORE_MACHINE_SCOPES,
      fetch: fakeFetch,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CoreMachineTokenError);
    expect((error as CoreMachineTokenError).status).toBe(401);
    expect((error as CoreMachineTokenError).code).toBe("invalid_client");
    expect((error as CoreMachineTokenError).message).not.toContain(BASE_CONFIG.clientSecret);
  });
});
