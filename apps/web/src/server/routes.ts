/**
 * Katalog ścieżek API TimoTime (`/api/v1/*`): jedno źródło prawdy dla generatora OpenAPI 3.1
 * (`openapi.ts`) i testów zgodności z kontraktem produktu (ADR-0044, ADR-0046).
 *
 * Moduł celowo nie importuje `server-only` i używa wyłącznie składni usuwalnej typów TypeScript,
 * dzięki czemu Node 24 uruchamia generator OpenAPI bez dodatkowego kompilatora.
 */
import {
  API_PREFIX,
  Health,
  MAX_ENTRIES_RANGE_DAYS,
  Me,
  StartTimeEntryInput,
  StopTimeEntryInput,
  TeamCurrentList,
  TeamTimeEntriesList,
  TimeEntriesList,
  TimeEntry,
  type ErrorCode,
} from "@timotime/contracts";
import { z } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RouteTag = "System" | "Session" | "Time" | "Team";

/**
 * Wymagane uwierzytelnienie trasy:
 * - `false`: publiczna (bez tokenu i bez sesji),
 * - `"session"`: wyłącznie sesja BFF przeglądarki w ciasteczku `HttpOnly`,
 * - `"user"`: token użytkownika `Bearer` (aplikacja mobilna) albo sesja BFF przeglądarki.
 */
export type RouteAuth = false | "session" | "user";

export interface TagDefinition {
  name: RouteTag;
  description: string;
}

export const TAGS: readonly TagDefinition[] = [
  { name: "System", description: "Stan usługi TimoTime." },
  { name: "Session", description: "Dane zalogowanej osoby, firmy i możliwości widoczne w przeglądarce (BFF)." },
  { name: "Time", description: "Rejestracja i odczyt własnych wpisów czasu pracy." },
  { name: "Team", description: "Widok kierownika: bieżący status i wpisy zespołu w zakresie uprawnień." },
];

export type SuccessStatus = 200 | 201 | 204;
export type ErrorStatus = 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503;
export type RouteErrors = Partial<Record<ErrorStatus, readonly ErrorCode[]>>;

export interface ParameterDefinition {
  name: string;
  in: "path" | "query";
  required: boolean;
  description: string;
  schema: z.ZodType;
}

export interface RouteDefinition {
  method: HttpMethod;
  /** Ścieżka w formacie OpenAPI (np. `/api/v1/time/entries`). */
  path: string;
  operationId: string;
  tag: RouteTag;
  summary: string;
  description?: string;
  auth: RouteAuth;
  /** Kod odpowiedzi sukcesu. */
  successStatus: SuccessStatus;
  /** Czy odpowiedź sukcesu jest owinięta w kopertę `{ data, meta, error }` (nie dotyczy 204). */
  envelope: boolean;
  /** Parametry ścieżki (`path`) i zapytania (`query`). */
  parameters?: readonly ParameterDefinition[];
  /** Nazwa i schemat treści żądania (dla POST/PUT/PATCH). */
  requestBodySchemaName?: string;
  requestBodySchema?: z.ZodType;
  requestBodyRequired?: boolean;
  requestBodyDescription?: string;
  /** Nazwa schematu danych w `components/schemas` (brak przy 204). */
  dataSchemaName?: string;
  dataSchema?: z.ZodType;
  /** Nazwa schematu odpowiedzi w `components/schemas` dla odpowiedzi z kopertą (np. `MeResponse`). */
  responseSchemaName?: string;
  responseDescription: string;
  errors: RouteErrors;
}

/** Otwarty wpis czasu pracy zalogowanej osoby albo `null`, gdy aktualnie nic nie trwa. */
export const CurrentTimeEntry = TimeEntry.nullable();

const DateRangeParamSchema = z.string().min(1);

const RANGE_PARAMETERS: readonly ParameterDefinition[] = [
  {
    name: "from",
    in: "query",
    required: false,
    description:
      `Początek przedziału dat w formacie ISO 8601 (YYYY-MM-DD lub pełny znacznik czasu UTC). ` +
      `Domyślnie początek dzisiejszego dnia w UTC; maksymalna rozpiętość przedziału to ${MAX_ENTRIES_RANGE_DAYS} dni.`,
    schema: DateRangeParamSchema,
  },
  {
    name: "to",
    in: "query",
    required: false,
    description:
      `Koniec przedziału dat w formacie ISO 8601 (YYYY-MM-DD lub pełny znacznik czasu UTC). ` +
      `Domyślnie koniec dzisiejszego dnia w UTC; data końcowa nie może być wcześniejsza niż początkowa.`,
    schema: DateRangeParamSchema,
  },
];

export const ROUTES = {
  getHealth: {
    method: "GET",
    path: `${API_PREFIX}/health`,
    operationId: "getHealth",
    tag: "System",
    summary: "Stan usługi TimoTime",
    description: "Publiczna kontrola zdrowia serwera API bez sprawdzania bazy danych i MonoriseCore.",
    auth: false,
    successStatus: 200,
    envelope: true,
    dataSchemaName: "Health",
    dataSchema: Health,
    responseSchemaName: "HealthResponse",
    responseDescription: "Usługa działa.",
    errors: {
      500: ["INTERNAL"],
    },
  },
  getMe: {
    method: "GET",
    path: `${API_PREFIX}/me`,
    operationId: "getMe",
    tag: "Session",
    summary: "Zalogowana osoba, firma i możliwości w TimoTime",
    description:
      "Zwraca profil osoby i firmy pobrany z MonoriseCore (`GET /core/v1/me`) oraz pole `capabilities` wyliczone " +
      "z migawki uprawnień produktu `timotime`. Dostępne wyłącznie przez sesję BFF przeglądarki (ciasteczko); " +
      "aplikacja mobilna z tokenem Bearer otrzymuje `403 PERMISSION_DENIED`, bo pobiera profil bezpośrednio z Core API.",
    auth: "session",
    successStatus: 200,
    envelope: true,
    dataSchemaName: "Me",
    dataSchema: Me,
    responseSchemaName: "MeResponse",
    responseDescription: "Profil zalogowanej osoby, firma i możliwości w interfejsie.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PERMISSION_DENIED"],
      500: ["INTERNAL"],
      503: ["INTERNAL"],
    },
  },
  getCurrentTimeEntry: {
    method: "GET",
    path: `${API_PREFIX}/time/current`,
    operationId: "getCurrentTimeEntry",
    tag: "Time",
    summary: "Bieżący otwarty wpis czasu pracy",
    description:
      "Zwraca aktualnie otwarty wpis zalogowanej osoby (`endedAt: null`) albo `null`. " +
      "Wymaga aktywnego dostępu do produktu `timotime` i uprawnienia `timotime.entries.read_own`.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    dataSchemaName: "CurrentTimeEntry",
    dataSchema: CurrentTimeEntry,
    responseSchemaName: "CurrentTimeEntryResponse",
    responseDescription: "Otwarty wpis czasu pracy albo null.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      500: ["INTERNAL"],
      503: ["INTERNAL"],
    },
  },
  startTimeEntry: {
    method: "POST",
    path: `${API_PREFIX}/time/start`,
    operationId: "startTimeEntry",
    tag: "Time",
    summary: "Rozpoczęcie nowego wpisu czasu pracy",
    description:
      "Otwiera nowy wpis czasu pracy wybranego rodzaju (`WORK`, `BREAK`, `REMOTE`, `BUSINESS_TRIP`). " +
      "Jeśli osoba ma już otwarty wpis, najpierw zamyka go w tej samej transakcji. Równoczesne wywołania " +
      "startu bez otwartego wpisu zwracają `409 CONFLICT`. Wymaga dostępu do produktu `timotime` i uprawnienia " +
      "`timotime.entries.write_own`.",
    auth: "user",
    successStatus: 201,
    envelope: true,
    requestBodySchemaName: "StartTimeEntryInput",
    requestBodySchema: StartTimeEntryInput,
    requestBodyRequired: true,
    requestBodyDescription: "Rodzaj nowego wpisu oraz opcjonalna notatka (do 500 znaków).",
    dataSchemaName: "TimeEntry",
    dataSchema: TimeEntry,
    responseSchemaName: "TimeEntryResponse",
    responseDescription: "Utworzony, otwarty wpis czasu pracy.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      409: ["CONFLICT"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL"],
      503: ["INTERNAL"],
    },
  },
  stopTimeEntry: {
    method: "POST",
    path: `${API_PREFIX}/time/stop`,
    operationId: "stopTimeEntry",
    tag: "Time",
    summary: "Zakończenie bieżącego wpisu czasu pracy",
    description:
      "Zamyka bieżący otwarty wpis zalogowanej osoby. Jeśli brak otwartego wpisu, zwraca `409 CONFLICT`. " +
      "Treść żądania jest opcjonalna (puste ciało lub `{}`). Wymaga dostępu do produktu `timotime` i uprawnienia " +
      "`timotime.entries.write_own`.",
    auth: "user",
    successStatus: 200,
    envelope: true,
    requestBodySchemaName: "StopTimeEntryInput",
    requestBodySchema: StopTimeEntryInput,
    requestBodyRequired: false,
    requestBodyDescription: "Opcjonalna notatka nadpisująca notatkę zamykanego wpisu (do 500 znaków).",
    dataSchemaName: "TimeEntry",
    dataSchema: TimeEntry,
    responseSchemaName: "TimeEntryResponse",
    responseDescription: "Zamknięty wpis czasu pracy.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      409: ["CONFLICT"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL"],
      503: ["INTERNAL"],
    },
  },
  listTimeEntries: {
    method: "GET",
    path: `${API_PREFIX}/time/entries`,
    operationId: "listTimeEntries",
    tag: "Time",
    summary: "Własne wpisy czasu pracy w przedziale dat",
    description:
      `Zapytanie zakresowe (bez stronicowania kursorowego): zwraca wszystkie własne wpisy nakładające się na ` +
      `przedział [from, to] (maksymalnie ${MAX_ENTRIES_RANGE_DAYS} dni, domyślnie dzisiejszy dzień w UTC), ` +
      `łącznie ze zmianami nocnymi i wpisami nadal otwartymi. Wymaga dostępu do produktu \`timotime\` i uprawnienia ` +
      `\`timotime.entries.read_own\`.`,
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: RANGE_PARAMETERS,
    dataSchemaName: "TimeEntriesList",
    dataSchema: TimeEntriesList,
    responseSchemaName: "TimeEntriesListResponse",
    responseDescription: "Własne wpisy czasu pracy oraz wyliczone granice przedziału [from, to].",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL"],
      503: ["INTERNAL"],
    },
  },
  getTeamCurrentEntries: {
    method: "GET",
    path: `${API_PREFIX}/team/current`,
    operationId: "getTeamCurrentEntries",
    tag: "Team",
    summary: "Kto z zespołu aktualnie pracuje",
    description:
      "Bieżący stan otwartych wpisów pracowników objętych zakresem uprawnienia `timotime.entries.read` " +
      "(`ORGANIZATION` albo poddrzewo jednostek `UNIT`; zapytanie nie jest stronicowane kursorowo). " +
      "Dane pracownika pochodzą z Core Directory, a baza wymusza separację firmy przez RLS (`withTeamScope`).",
    auth: "user",
    successStatus: 200,
    envelope: true,
    dataSchemaName: "TeamCurrentList",
    dataSchema: TeamCurrentList,
    responseSchemaName: "TeamCurrentListResponse",
    responseDescription: "Lista aktualnie otwartych wpisów pracowników w zakresie kierownika.",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      500: ["INTERNAL"],
      503: ["INTERNAL"],
    },
  },
  listTeamTimeEntries: {
    method: "GET",
    path: `${API_PREFIX}/team/entries`,
    operationId: "listTeamTimeEntries",
    tag: "Team",
    summary: "Wpisy czasu pracy zespołu w przedziale dat",
    description:
      `Zapytanie zakresowe (bez stronicowania kursorowego): zwraca wpisy czasu pracy pracowników z zakresu ` +
      `uprawnienia \`timotime.entries.read\` nakładające się na przedział [from, to] (maksymalnie ` +
      `${MAX_ENTRIES_RANGE_DAYS} dni, domyślnie dzisiejszy dzień w UTC), łącznie ze zmianami nocnymi i wpisami ` +
      `otwartymi. Wymaga dostępu do produktu \`timotime\` i uprawnienia \`timotime.entries.read\`.`,
    auth: "user",
    successStatus: 200,
    envelope: true,
    parameters: RANGE_PARAMETERS,
    dataSchemaName: "TeamTimeEntriesList",
    dataSchema: TeamTimeEntriesList,
    responseSchemaName: "TeamTimeEntriesListResponse",
    responseDescription: "Wpisy czasu pracy zespołu oraz wyliczone granice przedziału [from, to].",
    errors: {
      401: ["UNAUTHENTICATED"],
      403: ["PRODUCT_ACCESS_REQUIRED", "PERMISSION_DENIED"],
      422: ["VALIDATION_FAILED"],
      500: ["INTERNAL"],
      503: ["INTERNAL"],
    },
  },
} as const satisfies Record<string, RouteDefinition>;

export const ROUTE_LIST: readonly RouteDefinition[] = Object.values(ROUTES);
