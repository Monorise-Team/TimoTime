/**
 * Sesja aplikacji na telefon: tokeny z MonoriseCore w systemowym sejfie (ADR-0050), odświeżane
 * przed końcem ważności, osobno dla każdego zasobu API (np. API TimoTime i Core API). Logowanie przez
 * przeglądarkę systemową dostarcza platforma (`SignInProvider`). Przeglądarka tego nie używa (BFF).
 */

/** Pojedynczy token dostępu z czasem wygaśnięcia. */
export interface StoredAccessToken {
  accessToken: string;
  /** Koniec ważności tokenu dostępu (milisekundy od 1970). */
  expiresAt: number;
}

/** Tokeny z Core przechowywane w sejfie urządzenia. */
export interface AppTokens extends StoredAccessToken {
  refreshToken: string;
  /** Dodatkowe tokeny dostępu według identyfikatora zasobu API (np. Core API). */
  resources?: Record<string, StoredAccessToken>;
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
  /** Nowe tokeny (opcjonalnie dla wskazanego zasobu API); przy odmowie Core (`invalid_grant`) rzuca SessionExpiredError. */
  refresh(refreshToken: string, resource?: string): Promise<AppTokens>;
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
  /**
   * Ważny token dostępu albo `null`, gdy nikt nie jest zalogowany. Bez parametru zwraca token dla głównego API
   * produktu (pasuje do `getToken` klienta API); z parametrem `resource` zwraca token dla innego API (np. Core API).
   */
  accessToken(resource?: string): Promise<string | null>;
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
  // Dlatego wszystkie odświeżenia (niezależnie od zasobu) ustawiamy w jednej kolejce po kolei.
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(signedIn: boolean) => void>();
  const notify = (signedIn: boolean) => listeners.forEach((listener) => listener(signedIn));

  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function current(): Promise<AppTokens | null> {
    if (cached === undefined) cached = await store.read();
    return cached;
  }

  async function save(tokens: AppTokens | null): Promise<void> {
    cached = tokens;
    await store.write(tokens);
  }

  function tokenFor(tokens: AppTokens, resource?: string): StoredAccessToken | undefined {
    return resource ? tokens.resources?.[resource] : { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
  }

  function isFresh(entry: StoredAccessToken | undefined): entry is StoredAccessToken {
    return entry !== undefined && entry.expiresAt - now() > REFRESH_MARGIN_MS;
  }

  function ensureFresh(resource?: string): Promise<string | null> {
    return exclusive(async () => {
      // Poprzednie wywołanie w kolejce mogło już odświeżyć ten zasób albo wylogować użytkownika.
      const latest = await current();
      if (!latest) return null;
      const existing = tokenFor(latest, resource);
      if (isFresh(existing)) return existing.accessToken;

      let next: AppTokens;
      try {
        next = await provider.refresh(latest.refreshToken, resource);
      } catch (error) {
        if (error instanceof SessionExpiredError) {
          await save(null);
          notify(false);
          return null;
        }
        // Brak sieci albo awaria Core: tokeny zostają, kolejne żądanie spróbuje ponownie
        throw error;
      }

      const merged: AppTokens = resource
        ? {
            ...latest,
            refreshToken: next.refreshToken,
            resources: {
              ...latest.resources,
              [resource]: { accessToken: next.accessToken, expiresAt: next.expiresAt },
            },
          }
        : {
            ...latest,
            accessToken: next.accessToken,
            expiresAt: next.expiresAt,
            refreshToken: next.refreshToken,
          };
      await save(merged);
      return next.accessToken;
    });
  }

  return {
    async accessToken(resource?: string) {
      const tokens = await current();
      if (!tokens) return null;
      const entry = tokenFor(tokens, resource);
      if (isFresh(entry)) return entry.accessToken;
      return ensureFresh(resource);
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
