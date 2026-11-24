import { describe, expect, it } from "vitest";
import {
  createAppSession,
  SessionExpiredError,
  type AppTokens,
  type SignInProvider,
  type TokenStore,
} from "../src/index.js";

const MINUTE = 60_000;

function setup(start = 1_000_000) {
  let clock = start;
  let saved: AppTokens | null = null;
  const calls = { signIn: 0, refresh: 0, revoke: [] as string[], reads: 0 };
  let refreshError: Error | null = null;
  const issue = (n: number): AppTokens => ({
    accessToken: `dostep-${n}`,
    refreshToken: `odswiezanie-${n}`,
    expiresAt: clock + 5 * MINUTE,
  });
  const provider: SignInProvider = {
    signIn: async () => issue(++calls.signIn),
    refresh: async () => {
      calls.refresh++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (refreshError) throw refreshError;
      return issue(100 + calls.refresh);
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

  it("przy braku sieci zostawia tokeny, żeby spróbować ponownie", async () => {
    const { session, advance, failRefresh, saved } = setup();
    await session.signIn();
    advance(6 * MINUTE);
    failRefresh(new TypeError("Network request failed"));
    await expect(session.accessToken()).rejects.toThrow("Network request failed");
    expect(saved()?.refreshToken).toBe("odswiezanie-1");
  });

  it("wylogowanie czyści sejf i unieważnia token odświeżania w Core", async () => {
    const { session, calls, saved } = setup();
    await session.signIn();
    await session.signOut();
    expect(saved()).toBeNull();
    expect(await session.isSignedIn()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.revoke).toEqual(["odswiezanie-1"]);
  });
});
