import "server-only";
import { AuthError, AuthUnavailableError } from "@monorise-team/auth";
import { PermissionError } from "@monorise-team/permissions";
import {
  CoreApiError,
  CoreApiMissingTokenError,
  CoreApiProtocolError,
  CoreApiUnavailableError,
} from "@monorise-team/sdk";
import type { ApiErrorBody, ErrorCode } from "@timotime/contracts";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { config } from "./config";
import { CoreMachineTokenError } from "./core-machine";

/** Błąd API ze stałym kodem (standard API Monorise, ADR-0044). */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: ApiErrorBody["details"] = [],
  ) {
    super(message);
  }
}

const requestId = () => `req_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

function corsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get("origin");
  return origin && config.allowedOrigins.includes(origin)
    ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
    : {};
}

function respond(request: NextRequest, status: number, body: unknown, headers: Record<string, string> = {}) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...corsHeaders(request), ...headers },
  });
}

function toFailure(error: unknown): ApiFailure {
  if (error instanceof ApiFailure) return error;
  if (error instanceof ZodError) {
    return new ApiFailure(
      422,
      "VALIDATION_FAILED",
      "Niepoprawne dane",
      error.issues.map((issue) => ({ field: issue.path.join(".") || undefined, message: issue.message })),
    );
  }
  if (error instanceof AuthError) {
    return new ApiFailure(
      error.statusCode,
      error.code,
      error.code === "UNAUTHENTICATED" ? "Zaloguj się kontem Monorise" : "Żądanie spoza TimoTime",
    );
  }
  if (error instanceof AuthUnavailableError) {
    return new ApiFailure(503, "INTERNAL_ERROR", "Logowanie Monorise jest chwilowo niedostępne");
  }
  if (error instanceof PermissionError) {
    return new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnienia do tej operacji");
  }
  if (error instanceof CoreMachineTokenError) {
    return new ApiFailure(503, "INTERNAL_ERROR", "MonoriseCore jest chwilowo niedostępny");
  }
  if (error instanceof CoreApiMissingTokenError) {
    return new ApiFailure(401, "UNAUTHENTICATED", "Zaloguj się kontem Monorise");
  }
  if (error instanceof CoreApiError) {
    if (error.status === 401) {
      return new ApiFailure(401, "UNAUTHENTICATED", "Sesja w MonoriseCore wygasła lub konto jest nieaktywne");
    }
    if (error.status === 403) {
      return new ApiFailure(403, "PERMISSION_DENIED", "Brak uprawnień w MonoriseCore");
    }
    return new ApiFailure(503, "INTERNAL_ERROR", "MonoriseCore jest chwilowo niedostępny");
  }
  if (error instanceof CoreApiUnavailableError || error instanceof CoreApiProtocolError) {
    return new ApiFailure(503, "INTERNAL_ERROR", "MonoriseCore jest chwilowo niedostępny");
  }
  return new ApiFailure(500, "INTERNAL_ERROR", "Wewnętrzny błąd serwera");
}

export interface CookieJar {
  set: (
    name: string,
    value: string,
    options: { expires: Date; httpOnly: boolean; secure: boolean; sameSite: "lax" | "strict"; path: string },
  ) => void;
  delete: (name: string) => void;
}

export interface Context<P> {
  request: NextRequest;
  params: P;
  requestId: string;
  /** Ciasteczka odpowiedzi, dopisywane po wykonaniu trasy. */
  cookies: CookieJar;
}

/**
 * Obsługa trasy API: identyfikator żądania, odpowiedź `{ data, meta, error }`, zamiana błędów na kody,
 * ochrona przed CSRF dla ciasteczka sesji i nagłówki CORS.
 */
export function route<P = Record<string, never>>(
  fn: (context: Context<P>) => Promise<unknown>,
  { status = 200 }: { status?: number } = {},
) {
  return async (request: NextRequest, context: { params: Promise<P> }) => {
    const id = requestId();
    const pending: ((response: NextResponse) => void)[] = [];
    const cookies: CookieJar = {
      set: (name, value, options) => pending.push((response) => response.cookies.set(name, value, options)),
      delete: (name) => pending.push((response) => response.cookies.delete(name)),
    };
    try {
      assertSameOrigin(request);
      const data = await fn({ request, params: await context.params, requestId: id, cookies });
      const response = respond(request, status, { data: data ?? null, meta: { requestId: id }, error: null });
      for (const apply of pending) apply(response);
      return response;
    } catch (error) {
      const failure = toFailure(error);
      if (failure.status >= 500) {
        console.error(
          `[${id}] ${request.method} ${request.nextUrl.pathname}: ${failure.code}`,
          process.env.NODE_ENV === "production" ? (error instanceof Error ? error.name : "") : error,
        );
      }
      return respond(request, failure.status, {
        data: null,
        meta: { requestId: id },
        error: { code: failure.code, message: failure.message, details: failure.details },
      });
    }
  };
}

/**
 * Zmiany wysłane z ciasteczkiem sesji muszą pochodzić z tej samej strony (CSRF). Aplikacja na telefon
 * z tokenem w nagłówku Authorization nie wysyła ciasteczek, więc jej to nie dotyczy.
 */
function assertSameOrigin(request: NextRequest) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  if (request.headers.get("authorization")) return;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) {
    throw new ApiFailure(403, "PERMISSION_DENIED", "Żądanie spoza strony TimoTime");
  }
}

export async function readJson(request: NextRequest): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Oczekiwano JSON (Content-Type: application/json)");
  }
  try {
    return await request.json();
  } catch {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawny JSON");
  }
}

/** Odczytuje opcjonalne ciało JSON; przy pustym ciele zwraca pusty obiekt. */
export async function readOptionalJson(request: NextRequest): Promise<unknown> {
  const raw = await request.text();
  if (raw.trim().length === 0) return {};
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Oczekiwano JSON (Content-Type: application/json)");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawny JSON");
  }
}
