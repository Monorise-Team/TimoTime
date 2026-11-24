/**
 * Sesja aplikacji na telefon: tokeny z MonoriseCore w systemowym sejfie (ADR-0050), odświeżane
 * przed końcem ważności. Logowanie przez przeglądarkę systemową dostarcza platforma (`SignInProvider`).
 * Przeglądarka tego nie używa, bo tam sesję prowadzi serwer (BFF).
 */

/** Tokeny z Core. */
export interface AppTokens {
  accessToken: string;
  refreshToken: string;
  /** Koniec ważności tokenu dostępu (milisekundy od 1970). */
  expiresAt: number;
}

/** Systemowy sejf: Keychain na iOS albo Keystore na Androidzie. */
export interface TokenStore {
  read(): Promise<AppTokens | null>;
  write(tokens: AppTokens | null): Promise<void>;
}

/** Logowanie zależne od platformy. */
export interface SignInProvider {
  /** Przeglądarka systemowa z ekranem logowania Core, potem wymiana kodu na tokeny (PKCE). */
  signIn(): Promise<AppTokens>;
  /** Nowe tokeny; przy odmowie Core (`invalid_grant`) rzuca SessionExpiredError. */
  refresh(refreshToken: string): Promise<AppTokens>;
  /** Unieważnienie tokenu odświeżania w Core przy wylogowaniu. */
  revoke(refreshToken: string): Promise<void>;
}

/** Core nie przedłuża sesji (wylogowanie, dezaktywacja konta, unieważnione tokeny): trzeba zalogować się ponownie. */
export class SessionExpiredError extends Error {
  constructor(message = "Sesja wygasła. Zaloguj się ponownie.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

/** Token odświeżamy, gdy zostało mu mniej niż 30 sekund. */
const REFRESH_MARGIN_MS = 30_000;

export interface AppSession {
  /** Ważny token dostępu albo `null`, gdy nikt nie jest zalogowany. Pasuje do `getToken` klienta API. */
  accessToken(): Promise<string | null>;
  signIn(): Promise<void>;
  /** Kończy sesję w aplikacji i unieważnia token odświeżania w Core (bez czekania na odpowiedź Core). */
  signOut(): Promise<void>;
  isSignedIn(): Promise<boolean>;
  /** Powiadomienia o zalogowaniu i wylogowaniu (także gdy Core zakończy sesję); zwraca funkcję odpinającą. */
  subscribe(listener: (signedIn: boolean) => void): () => void;
}

export function createAppSession(
  provider: SignInProvider,
  store: TokenStore,
  now: () => number = Date.now,
): AppSession {
  // Tokeny trzymamy też w pamięci, żeby nie pytać sejfu przy każdym żądaniu do API.
  let cached: AppTokens | null | undefined;
  // Core wydaje przy odświeżeniu nowy token odświeżania i unieważnia całą rodzinę tokenów, gdy stary wróci.
  // Dlatego równoczesne żądania czekają na jedno odświeżenie.
  let refreshing: Promise<AppTokens | null> | null = null;
  const listeners = new Set<(signedIn: boolean) => void>();
  const notify = (signedIn: boolean) => listeners.forEach((listener) => listener(signedIn));

  async function current(): Promise<AppTokens | null> {
    cached ??= await store.read();
    return cached;
  }

  async function save(tokens: AppTokens | null): Promise<void> {
    cached = tokens;
    await store.write(tokens);
  }

  async function refresh(tokens: AppTokens): Promise<AppTokens | null> {
    try {
      const next = await provider.refresh(tokens.refreshToken);
      await save(next);
      return next;
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        await save(null);
        notify(false);
        return null;
      }
      // Brak sieci albo awaria Core: tokeny zostają, kolejne żądanie spróbuje ponownie
      throw error;
    }
  }

  return {
    async accessToken() {
      const tokens = await current();
      if (!tokens) return null;
      if (tokens.expiresAt - now() > REFRESH_MARGIN_MS) return tokens.accessToken;
      refreshing ??= refresh(tokens).finally(() => {
        refreshing = null;
      });
      return (await refreshing)?.accessToken ?? null;
    },
    async signIn() {
      await save(await provider.signIn());
      notify(true);
    },
    async signOut() {
      const tokens = await current();
      await save(null);
      notify(false);
      if (tokens) void provider.revoke(tokens.refreshToken).catch(() => undefined);
    },
    async isSignedIn() {
      return (await current()) !== null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
