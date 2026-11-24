import { describe, expect, it } from "vitest";
import {
  createAppSession,
  SessionExpiredError,
  type AppTokens,
  type SignInProvider,
  type TokenStore,
} from "../src/index.js";

const MINUTE = 60_000;
const CORE_API = "http://localhost:3200";

function setup(start = 1_000_000) {
  let clock = start;
  let saved: AppTokens | null = null;
  const calls = {
    signIn: 0,
    refresh: 0,
    refreshArgs: [] as { refreshToken: string; resource: string | undefined }[],
    revoke: [] as string[],
    reads: 0,
  };
  let refreshError: Error | null = null;
  const issue = (n: number, label = "dostep"): AppTokens => ({
    accessToken: `${label}-${n}`,
    refreshToken: `odswiezanie-${n}`,
    expiresAt: clock + 5 * MINUTE,
  });
  const provider: SignInProvider = {
    signIn: async () => issue(++calls.signIn),
    refresh: async (refreshToken, resource) => {
      calls.refresh++;
      calls.refreshArgs.push({ refreshToken, resource });
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (refreshError) throw refreshError;
      return issue(100 + calls.refresh, resource ? `zasob:${resource}` : "dostep");
    },
    revoke: async (token) => {
      calls.revoke.push(token);
    },
  };
  const store: TokenStore = {
    read: async () => {
      calls.reads++;
      return saved;
    },
    write: async (tokens) => {
      saved = tokens;
    },
  };
  const session = createAppSession(provider, store, () => clock);
  return {
    session,
    calls,
    advance: (ms: number) => (clock += ms),
    failRefresh: (error: Error) => (refreshError = error),
    saved: () => saved,
  };
}

describe("sesja aplikacji na telefon", () => {
  it("loguje, zapisuje tokeny w sejfie i podaje token dostępu", async () => {
    const { session, saved, calls } = setup();
    const changes: boolean[] = [];
    session.subscribe((signedIn) => changes.push(signedIn));
    expect(await session.accessToken()).toBeNull();
    await session.signIn();
    expect(await session.accessToken()).toBe("dostep-1");
    expect(saved()?.refreshToken).toBe("odswiezanie-1");
    expect(changes).toEqual([true]);
    await session.accessToken();
    expect(calls.reads).toBe(1);
  });

  it("odświeża raz, nawet przy równoczesnych żądaniach", async () => {
    const { session, calls, advance } = setup();
    await session.signIn();
    advance(6 * MINUTE);
    const tokens = await Promise.all([1, 2, 3].map(() => session.accessToken()));
    expect(tokens).toEqual(["dostep-101", "dostep-101", "dostep-101"]);
    expect(calls.refresh).toBe(1);
  });

  it("pobiera i cache'uje token dla osobnego zasobu API oraz zapisuje obrócony refresh token", async () => {
    const { session, calls, saved, advance } = setup();
    await session.signIn();

    const coreToken1 = await session.accessToken(CORE_API);
    expect(coreToken1).toBe(`zasob:${CORE_API}-101`);
    expect(calls.refreshArgs).toEqual([{ refreshToken: "odswiezanie-1", resource: CORE_API }]);
    expect(saved()?.refreshToken).toBe("odswiezanie-101");
    expect(saved()?.resources?.[CORE_API]?.accessToken).toBe(coreToken1);

    // Ponowne wywołanie korzysta z cache bez kolejnego odświeżania; główny token nadal działa
    expect(await session.accessToken(CORE_API)).toBe(coreToken1);
    expect(await session.accessToken()).toBe("dostep-1");
    expect(calls.refresh).toBe(1);

    // Po wygaśnięciu głównego tokenu używa już nowego (obróconego) tokenu odświeżania
    advance(6 * MINUTE);
    expect(await session.accessToken()).toBe("dostep-102");
    expect(calls.refreshArgs[1]).toEqual({ refreshToken: "odswiezanie-101", resource: undefined });
    expect(saved()?.refreshToken).toBe("odswiezanie-102");
  });

  it("równoczesne żądania tego samego zasobu dzielą jedno odświeżenie, a różnych zasobów idą po kolei", async () => {
    const { session, calls, advance } = setup();
    await session.signIn();

    const sameResource = await Promise.all([1, 2, 3].map(() => session.accessToken(CORE_API)));
    expect(sameResource).toEqual([`zasob:${CORE_API}-101`, `zasob:${CORE_API}-101`, `zasob:${CORE_API}-101`]);
    expect(calls.refresh).toBe(1);

    // Oba tokeny wygasają; równoczesne żądania dwóch zasobów nie używają tego samego refresh tokenu naraz
    advance(6 * MINUTE);
    const [primaryToken, coreToken] = await Promise.all([session.accessToken(), session.accessToken(CORE_API)]);
    expect(primaryToken).toBe("dostep-102");
    expect(coreToken).toBe(`zasob:${CORE_API}-103`);
    expect(calls.refreshArgs.slice(1)).toEqual([
      { refreshToken: "odswiezanie-101", resource: undefined },
      { refreshToken: "odswiezanie-102", resource: CORE_API },
    ]);
  });

  it("gdy Core nie przedłuża sesji, wylogowuje i czyści sejf", async () => {
    const { session, advance, failRefresh, saved } = setup();
    const changes: boolean[] = [];
    session.subscribe((signedIn) => changes.push(signedIn));
    await session.signIn();
    advance(6 * MINUTE);
    failRefresh(new SessionExpiredError());
    expect(await session.accessToken()).toBeNull();
    expect(saved()).toBeNull();
    expect(changes).toEqual([true, false]);
  });

  it("gdy Core odrzuci odświeżenie tokenu innego zasobu, wylogowuje i czyści sejf", async () => {
    const { session, failRefresh, saved } = setup();
    const changes: boolean[] = [];
    session.subscribe((signedIn) => changes.push(signedIn));
    await session.signIn();
    failRefresh(new SessionExpiredError());
    expect(await session.accessToken(CORE_API)).toBeNull();
    expect(saved()).toBeNull();
    expect(changes).toEqual([true, false]);
  });

  it("przy braku sieci zostawia tokeny, żeby spróbować ponownie", async () => {
    const { session, advance, failRefresh, saved } = setup();
    await session.signIn();
    advance(6 * MINUTE);
    failRefresh(new TypeError("Network request failed"));
    await expect(session.accessToken()).rejects.toThrow("Network request failed");
    expect(saved()?.refreshToken).toBe("odswiezanie-1");
  });

  it("wylogowanie czyści sejf i unieważnia najnowszy token odświeżania w Core", async () => {
    const { session, calls, saved } = setup();
    await session.signIn();
    await session.accessToken(CORE_API);
    await session.signOut();
    expect(saved()).toBeNull();
    expect(await session.isSignedIn()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.revoke).toEqual(["odswiezanie-101"]);
  });
});
