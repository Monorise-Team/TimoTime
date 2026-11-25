/**
 * Generator opisu OpenAPI 3.1.0 dla API TimoTime (`/api/v1/*`) na podstawie katalogu ścieżek
 * (`routes.ts`) i schematów Zod z `@timotime/contracts` (ADR-0044, ADR-0046).
 *
 * Moduł celowo nie importuje `server-only` i używa wyłącznie składni usuwalnej typów TypeScript,
 * dzięki czemu uruchamia go bezpośrednio Node 24 (`pnpm openapi`, `pnpm openapi:check`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ApiErrorBody,
  ApiErrorDetail,
  ApiErrorResponse,
  ApiMeta,
  apiSuccessSchema,
  Capabilities,
  ErrorCode,
  Health,
  Me,
  StartTimeEntryInput,
  StopTimeEntryInput,
  TeamCurrentList,
  TeamEmployee,
  TeamTimeEntriesList,
  TeamTimeEntry,
  TimeEntriesList,
  TimeEntry,
  TimeEntryKind,
} from "@timotime/contracts";
import { z } from "zod";
import {
  CurrentTimeEntry,
  ROUTE_LIST,
  TAGS,
  type ErrorStatus,
  type ParameterDefinition,
  type RouteAuth,
  type RouteDefinition,
} from "./routes.ts";

const ROOT_PACKAGE_JSON_PATH = resolve(import.meta.dirname, "../../../../package.json");

const ERROR_STATUS_SUMMARY: Record<ErrorStatus, string> = {
  401: "Brak albo nieważny token dostępu albo wygasła sesja",
  403: "Brak dostępu do produktu albo brak uprawnienia",
  404: "Nie znaleziono zasobu",
  409: "Konflikt stanu wpisu czasu pracy",
  422: "Błędne dane wejściowe",
  429: "Przekroczony limit zapytań",
  500: "Wewnętrzny błąd serwera",
  503: "Usługa zależna (MonoriseCore) chwilowo niedostępna",
};

const METHOD_ORDER = ["get", "post", "put", "patch", "delete"] as const;

export type OpenApiSecurityScheme =
  | {
      type: "http";
      scheme: "bearer";
      bearerFormat: string;
      description: string;
    }
  | {
      type: "apiKey";
      in: "cookie";
      name: string;
      description: string;
    };

export interface OpenApiSpec {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
    summary: string;
    description: string;
    license: {
      name: string;
      identifier: string;
    };
  };
  servers: { url: string; description: string }[];
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    securitySchemes: Record<string, OpenApiSecurityScheme>;
    schemas: Record<string, Record<string, unknown>>;
  };
}

export interface OpenApiParameterObject {
  name: string;
  in: "path" | "query";
  required: boolean;
  description: string;
  schema: Record<string, unknown>;
}

export interface OpenApiRequestBodyObject {
  required: boolean;
  description?: string;
  content: {
    "application/json": {
      schema: { $ref: string };
    };
  };
}

export interface OpenApiResponseObject {
  description: string;
  content?: {
    "application/json": {
      schema: { $ref: string };
    };
  };
}

export interface OpenApiOperation {
  tags: string[];
  operationId: string;
  summary: string;
  description?: string;
  security?: Record<string, string[]>[];
  parameters?: OpenApiParameterObject[];
  requestBody?: OpenApiRequestBodyObject;
  responses: Record<string, OpenApiResponseObject>;
}

function readRootVersion(): string {
  const raw = readFileSync(ROOT_PACKAGE_JSON_PATH, "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || !parsed.version) {
    throw new Error(`Brak poprawnego pola "version" w ${ROOT_PACKAGE_JSON_PATH}`);
  }
  return parsed.version;
}

function stripSchemaMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema" || key === "$id") continue;
    result[key] = value;
  }
  return result;
}

function buildSchemaRegistry(routes: readonly RouteDefinition[]) {
  const registry = z.registry<{ id: string }>();
  const idBySchema = new Map<z.ZodType, string>();
  const register = (id: string, schema: z.ZodType) => {
    if (!registry.has(schema)) {
      registry.add(schema, { id });
      idBySchema.set(schema, id);
    }
  };

  register("ErrorCode", ErrorCode);
  register("ApiErrorDetail", ApiErrorDetail);
  register("ApiErrorBody", ApiErrorBody);
  register("ApiMeta", ApiMeta);
  register("ApiErrorResponse", ApiErrorResponse);
  register("Health", Health);
  register("Capabilities", Capabilities);
  register("Me", Me);
  register("TimeEntryKind", TimeEntryKind);
  register("TimeEntry", TimeEntry);
  register("CurrentTimeEntry", CurrentTimeEntry);
  register("StartTimeEntryInput", StartTimeEntryInput);
  register("StopTimeEntryInput", StopTimeEntryInput);
  register("TimeEntriesList", TimeEntriesList);
  register("TeamEmployee", TeamEmployee);
  register("TeamTimeEntry", TeamTimeEntry);
  register("TeamCurrentList", TeamCurrentList);
  register("TeamTimeEntriesList", TeamTimeEntriesList);

  const responseEnvelopes = new Map<string, z.ZodType>();
  for (const route of routes) {
    if (route.requestBodySchemaName && route.requestBodySchema) {
      register(route.requestBodySchemaName, route.requestBodySchema);
    }
    if (route.dataSchemaName && route.dataSchema) {
      register(route.dataSchemaName, route.dataSchema);
      if (route.envelope && route.responseSchemaName && !responseEnvelopes.has(route.responseSchemaName)) {
        const envelopeSchema = apiSuccessSchema(route.dataSchema);
        responseEnvelopes.set(route.responseSchemaName, envelopeSchema);
        register(route.responseSchemaName, envelopeSchema);
      }
    }
  }

  return { registry, idBySchema };
}

function buildComponentSchemas(registry: ReturnType<typeof buildSchemaRegistry>["registry"]) {
  // `io: "input"` pozwala wygenerować JSON Schema także dla schematów wejściowych z `.transform()` (np. przycinanie notatki).
  const generated = z.toJSONSchema(registry, {
    target: "draft-2020-12",
    io: "input",
    uri: (id) => `#/components/schemas/${id}`,
  });

  const sorted: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(generated.schemas).sort()) {
    const schema = generated.schemas[name];
    if (schema) sorted[name] = stripSchemaMeta(schema as Record<string, unknown>);
  }
  return sorted;
}

function buildParameter(
  param: ParameterDefinition,
  idBySchema: ReadonlyMap<z.ZodType, string>,
): OpenApiParameterObject {
  const registeredId = idBySchema.get(param.schema);
  const schema = registeredId
    ? { $ref: `#/components/schemas/${registeredId}` }
    : stripSchemaMeta(
        z.toJSONSchema(param.schema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>,
      );
  return {
    name: param.name,
    in: param.in,
    required: param.required,
    description: param.description,
    schema,
  };
}

function describeError(status: ErrorStatus, codes: readonly string[]): string {
  const base = ERROR_STATUS_SUMMARY[status];
  return codes.length > 0 ? `${base} (${codes.join(", ")}).` : `${base}.`;
}

function buildSecurity(auth: RouteAuth): Record<string, string[]>[] | undefined {
  if (auth === false) return undefined;
  if (auth === "session") return [{ sessionCookie: [] }];
  return [{ bearerAuth: [] }, { sessionCookie: [] }];
}

function buildOperation(route: RouteDefinition, idBySchema: ReadonlyMap<z.ZodType, string>): OpenApiOperation {
  const responses: Record<string, OpenApiResponseObject> = {};

  if (route.successStatus === 204) {
    responses["204"] = {
      description: route.responseDescription,
    };
  } else {
    const successSchemaName =
      route.envelope && route.responseSchemaName ? route.responseSchemaName : route.dataSchemaName;
    if (!successSchemaName) {
      throw new Error(`Brak schematu odpowiedzi dla operacji ${route.operationId}`);
    }
    responses[String(route.successStatus)] = {
      description: route.responseDescription,
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${successSchemaName}` },
        },
      },
    };
  }

  const errorStatuses = Object.keys(route.errors)
    .map(Number)
    .sort((a, b) => a - b) as ErrorStatus[];

  for (const status of errorStatuses) {
    const codes = route.errors[status];
    if (!codes) continue;
    responses[String(status)] = {
      description: describeError(status, codes),
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ApiErrorResponse" },
        },
      },
    };
  }

  const parameters =
    route.parameters && route.parameters.length > 0
      ? route.parameters.map((param) => buildParameter(param, idBySchema))
      : undefined;

  const requestBody: OpenApiRequestBodyObject | undefined = route.requestBodySchemaName
    ? {
        required: route.requestBodyRequired ?? true,
        ...(route.requestBodyDescription ? { description: route.requestBodyDescription } : {}),
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${route.requestBodySchemaName}` },
          },
        },
      }
    : undefined;

  const security = buildSecurity(route.auth);

  return {
    tags: [route.tag],
    operationId: route.operationId,
    summary: route.summary,
    ...(route.description ? { description: route.description } : {}),
    ...(security ? { security } : {}),
    ...(parameters ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses,
  };
}

function buildPaths(
  routes: readonly RouteDefinition[],
  idBySchema: ReadonlyMap<z.ZodType, string>,
): Record<string, Record<string, OpenApiOperation>> {
  const grouped = new Map<string, Map<string, OpenApiOperation>>();
  for (const route of routes) {
    const method = route.method.toLowerCase();
    const methods = grouped.get(route.path) ?? new Map<string, OpenApiOperation>();
    methods.set(method, buildOperation(route, idBySchema));
    grouped.set(route.path, methods);
  }

  const paths: Record<string, Record<string, OpenApiOperation>> = {};
  for (const path of [...grouped.keys()].sort()) {
    const methods = grouped.get(path);
    if (!methods) continue;
    const item: Record<string, OpenApiOperation> = {};
    for (const method of METHOD_ORDER) {
      const operation = methods.get(method);
      if (operation) item[method] = operation;
    }
    paths[path] = item;
  }
  return paths;
}

/**
 * Buduje deterministyczny opis OpenAPI 3.1.0 dla API TimoTime na podstawie katalogu ścieżek
 * i schematów Zod z `@timotime/contracts`.
 */
export function buildOpenApiDocument(): OpenApiSpec {
  const usedTags = new Set(ROUTE_LIST.map((route) => route.tag));
  const { registry, idBySchema } = buildSchemaRegistry(ROUTE_LIST);

  return {
    openapi: "3.1.0",
    info: {
      title: "TimoTime API",
      version: readRootVersion(),
      summary: "API ewidencji czasu pracy TimoTime: rejestracja własnego czasu pracy, widok zespołu i stan usługi.",
      description:
        "Opis API TimoTime (`/api/v1/*`) wygenerowany automatycznie z kodu (katalog ścieżek i schematy Zod). " +
        "Wszystkie odpowiedzi ustawiają nagłówek `Cache-Control: no-store` i używają koperty `{ data, meta, error }` " +
        "(ADR-0044). Tożsamość osoby i firmy zawsze wynika z tokenu albo sesji MonoriseCore (ADR-0037). " +
        "Trasy `entries` są zapytaniami zakresowymi po przedziale dat [from, to] (maksymalnie 31 dni) i nie używają " +
        "stronicowania kursorowego.",
      license: {
        name: "Proprietary, all rights reserved",
        identifier: "LicenseRef-Proprietary",
      },
    },
    servers: [
      { url: "http://time.localhost:3300", description: "Lokalnie" },
      { url: "https://time.monorise.studio", description: "Produkcja" },
    ],
    tags: TAGS.filter((tag) => usedTags.has(tag.name)).map((tag) => ({
      name: tag.name,
      description: tag.description,
    })),
    paths: buildPaths(ROUTE_LIST, idBySchema),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "Token dostępu użytkownika JWT (EdDSA) z auth.monorise.studio z odbiorcą API TimoTime (aplikacja mobilna, ADR-0023).",
        },
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "__Host-monorise-session",
          description:
            "Sesja BFF przeglądarki w ciasteczku HttpOnly (__Host-monorise-session w produkcji, monorise-session na http://localhost; ADR-0050). Żądania mutujące wymagają zgodnego nagłówka Origin.",
        },
      },
      schemas: buildComponentSchemas(registry),
    },
  };
}

export function serializeOpenApiDocument(document: OpenApiSpec = buildOpenApiDocument()): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
