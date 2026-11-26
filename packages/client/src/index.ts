/**
 * Typowany klient API TimoTime dla przeglądarki i telefonu (Expo). Przeglądarka używa
 * ciasteczka sesji (BFF, ADR-0050), aplikacja na telefon tokenu z systemowego sejfu (`getToken`).
 */
import {
  API_PREFIX,
  type ApiErrorBody,
  type ApiResponse,
  type ErrorCode,
  type Me,
  type StartTimeEntryInput,
  type StopTimeEntryInput,
  type TeamCurrentList,
  type TeamTimeEntriesList,
  type TimeEntriesList,
  type TimeEntriesQuery,
  type TimeEntry,
} from "@timotime/contracts";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ApiErrorBody["details"];

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.status = status;
    this.details = body.details;
  }
}

export interface ClientOptions {
  /** Adres serwera, np. `https://time.monorise.studio`; pusty w przeglądarce (ten sam adres). */
  baseUrl?: string;
  /** Token aplikacji na telefon; przeglądarka go nie ma (ciasteczko). */
  getToken?: () => string | null | Promise<string | null>;
  fetch?: typeof fetch;
}

export type TimoTimeClient = ReturnType<typeof createClient>;

export function createClient({ baseUrl = "", getToken, fetch: fetchImpl = fetch }: ClientOptions = {}) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = getToken ? await getToken() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${API_PREFIX}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: getToken ? "omit" : "same-origin",
      });
    } catch {
      throw new ApiError(0, { code: "INTERNAL_ERROR", message: "Brak połączenia z serwerem TimoTime", details: [] });
    }
    const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;
    if (!response.ok || !payload || payload.error) {
      throw new ApiError(
        response.status,
        payload?.error ?? { code: "INTERNAL_ERROR", message: `Błąd serwera (${response.status})`, details: [] },
      );
    }
    return payload.data as T;
  }

  return {
    session: {
      me: () => request<Me>("GET", "/me"),
      /**
       * Wylogowanie w przeglądarce (BFF): serwer kończy sesję i unieważnia token w Core. Odpowiedź to
       * przekierowanie, którego nie śledzimy; potem wystarczy ponownie zapytać o `me`.
       */
      signOut: async () => {
        await fetchImpl(`${baseUrl}/api/auth/sign-out`, {
          method: "POST",
          credentials: "same-origin",
          redirect: "manual",
        });
      },
    },
    time: {
      current: () => request<TimeEntry | null>("GET", "/time/current"),
      start: (input: StartTimeEntryInput) => request<TimeEntry>("POST", "/time/start", input),
      stop: (input?: StopTimeEntryInput) => request<TimeEntry>("POST", "/time/stop", input ?? {}),
      entries: (range?: TimeEntriesQuery) => {
        const params = new URLSearchParams();
        if (range?.from) params.set("from", range.from);
        if (range?.to) params.set("to", range.to);
        const query = params.toString();
        return request<TimeEntriesList>("GET", `/time/entries${query ? `?${query}` : ""}`);
      },
    },
    team: {
      current: () => request<TeamCurrentList>("GET", "/team/current"),
      entries: (range?: TimeEntriesQuery) => {
        const params = new URLSearchParams();
        if (range?.from) params.set("from", range.from);
        if (range?.to) params.set("to", range.to);
        const query = params.toString();
        return request<TeamTimeEntriesList>("GET", `/team/entries${query ? `?${query}` : ""}`);
      },
    },
  };
}

export {
  TIME_ENTRY_KIND_LABELS,
  TIME_ENTRY_KINDS,
  type Capabilities,
  type Me,
  type StartTimeEntryInput,
  type StopTimeEntryInput,
  type TeamCurrentList,
  type TeamEmployee,
  type TeamTimeEntriesList,
  type TeamTimeEntry,
  type TimeEntriesList,
  type TimeEntriesQuery,
  type TimeEntry,
  type TimeEntryKind,
} from "@timotime/contracts";

export {
  createAppSession,
  SessionExpiredError,
  type AppSession,
  type AppTokens,
  type SignInProvider,
  type StoredAccessToken,
  type TokenStore,
} from "./session.js";
