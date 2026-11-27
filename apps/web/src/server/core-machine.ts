/**
 * Token maszynowy OAuth 2.1 (`client_credentials`) serwera TimoTime (`timotime-web`) do Core API.
 *
 * Moduł celowo nie importuje `server-only` i używa wyłącznie składni usuwalnej typów TypeScript,
 * dzięki czemu może z niego korzystać zarówno serwer Next.js, jak i narzędzie CLI
 * (`pnpm permissions:register`) uruchamiane bezpośrednio w Node 24.
 */
import { z } from "zod";

export const CORE_PERMISSIONS_REGISTER_SCOPE = "core:permissions.register";
export const CORE_PERMISSIONS_READ_SCOPE = "core:permissions.read";
export const CORE_DIRECTORY_READ_SCOPE = "core:directory.read";
export const CORE_EVENTS_READ_SCOPE = "core:events.read";
export const CORE_NOTIFICATIONS_SEND_SCOPE = "core:notifications.send";
export const CORE_MACHINE_SCOPES = `${CORE_PERMISSIONS_READ_SCOPE} ${CORE_DIRECTORY_READ_SCOPE} ${CORE_EVENTS_READ_SCOPE} ${CORE_NOTIFICATIONS_SEND_SCOPE}`;

export const DEFAULT_TOKEN_REFRESH_MARGIN_MS = 30_000;
const DEFAULT_TOKEN_TTL_SECONDS = 300;

export interface MachineTokenConfig {
  coreAuthUrl: string;
  coreApiUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface MachineTokenResult {
  accessToken: string;
  /** Ważność tokenu w sekundach z odpowiedzi Core (domyślnie 300 s). */
  expiresIn: number;
}

export class CoreMachineTokenError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(
    message: string,
    options?: {
      status?: number;
      code?: string;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "CoreMachineTokenError";
    this.status = options?.status;
    this.code = options?.code;
  }
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
});

const OAuthErrorResponseSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
  message: z.string().optional(),
});

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function normalizeBaseUrl(raw: string, label: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CoreMachineTokenError(`Nieprawidłowy adres URL w zmiennej ${label}.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CoreMachineTokenError(`Adres w zmiennej ${label} musi używać protokołu http lub https.`);
  }
  return trimmed;
}

function validateMachineTokenConfig(raw: MachineTokenConfig): MachineTokenConfig {
  const missing: string[] = [];
  if (!raw.coreAuthUrl.trim()) missing.push("CORE_AUTH_URL");
  if (!raw.coreApiUrl.trim()) missing.push("CORE_API_URL");
  if (!raw.clientId.trim()) missing.push("TIMOTIME_OAUTH_CLIENT_ID");
  if (!raw.clientSecret.trim()) missing.push("TIMOTIME_OAUTH_CLIENT_SECRET");
  if (missing.length > 0) {
    throw new CoreMachineTokenError(
      `Brak wymaganej konfiguracji tokenu maszynowego MonoriseCore: ${missing.join(", ")}.`,
    );
  }
  return {
    coreAuthUrl: normalizeBaseUrl(raw.coreAuthUrl, "CORE_AUTH_URL"),
    coreApiUrl: normalizeBaseUrl(raw.coreApiUrl, "CORE_API_URL"),
    clientId: raw.clientId.trim(),
    clientSecret: raw.clientSecret.trim(),
  };
}

export interface RequestMachineTokenOptions extends MachineTokenConfig {
  scope: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Pobiera pojedynczy token maszynowy OAuth 2.1 (`grant_type=client_credentials`) z serwera logowania
 * MonoriseCore dla wskazanego zakresu i odbiorcy (`resource` = `coreApiUrl`). Nigdy nie wypisuje sekretów.
 */
export async function requestMachineToken(options: RequestMachineTokenOptions): Promise<MachineTokenResult> {
  const cfg = validateMachineTokenConfig(options);
  const fetchFn = options.fetch ?? globalThis.fetch;
  const tokenUrl = `${cfg.coreAuthUrl}/api/auth/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    resource: cfg.coreApiUrl,
    scope: options.scope,
  });

  let response: Response;
  try {
    response = await fetchFn(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CoreMachineTokenError(
      `Nie udało się połączyć z serwerem logowania MonoriseCore (${tokenUrl}): ${reason}`,
      { cause: error },
    );
  }

  const payload = await readJsonSafely(response);
  if (!response.ok) {
    const parsedError = OAuthErrorResponseSchema.safeParse(payload);
    const errorCode = parsedError.success ? parsedError.data.error : undefined;
    const errorDescription = parsedError.success
      ? (parsedError.data.error_description ?? parsedError.data.message)
      : undefined;
    const parts = [errorCode, errorDescription].filter((part): part is string => Boolean(part && part.trim()));
    const suffix = parts.length > 0 ? `: ${parts.join(" (")}${parts.length > 1 ? ")" : ""}` : "";
    throw new CoreMachineTokenError(
      `Serwer logowania MonoriseCore odrzucił prośbę o token maszynowy (HTTP ${response.status})${suffix}.`,
      {
        status: response.status,
        code: errorCode,
      },
    );
  }

  const parsedToken = TokenResponseSchema.safeParse(payload);
  if (!parsedToken.success) {
    throw new CoreMachineTokenError(
      "Serwer logowania MonoriseCore zwrócił odpowiedź bez poprawnego pola access_token.",
      { status: response.status },
    );
  }

  return {
    accessToken: parsedToken.data.access_token,
    expiresIn: parsedToken.data.expires_in ?? DEFAULT_TOKEN_TTL_SECONDS,
  };
}

export interface MachineTokenProviderOptions {
  getConfig: () => MachineTokenConfig;
  scope: string;
  /** Margines przed wygaśnięciem tokenu, po którym następuje odświeżenie (domyślnie 30 s). */
  refreshMarginMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export interface MachineTokenProvider {
  getAccessToken(): Promise<string>;
  clear(): void;
}

interface CachedToken {
  key: string;
  accessToken: string;
  expiresAt: number;
}

interface InFlightRefresh {
  key: string;
  invalidated: boolean;
  promise: Promise<string>;
}

/**
 * Dostawca tokenu maszynowego z pamięcią podręczną (do 30 s przed wygaśnięciem) i pojedynczym
 * odświeżaniem w locie (równoczesne żądania współdzielą jedną prośbę do serwera OAuth Core).
 */
export function createMachineTokenProvider(options: MachineTokenProviderOptions): MachineTokenProvider {
  const refreshMarginMs = options.refreshMarginMs ?? DEFAULT_TOKEN_REFRESH_MARGIN_MS;
  const now = options.now ?? Date.now;

  let cached: CachedToken | null = null;
  let inFlight: InFlightRefresh | null = null;

  function cacheKey(cfg: MachineTokenConfig): string {
    return `${cfg.coreAuthUrl.trim()}\0${cfg.coreApiUrl.trim()}\0${cfg.clientId.trim()}\0${options.scope}`;
  }

  function clear(): void {
    cached = null;
    if (inFlight) {
      inFlight.invalidated = true;
      inFlight = null;
    }
  }

  async function getAccessToken(): Promise<string> {
    const cfg = options.getConfig();
    const key = cacheKey(cfg);

    if (cached && cached.key === key && cached.expiresAt - now() > refreshMarginMs) {
      return cached.accessToken;
    }

    if (inFlight && inFlight.key === key) {
      return inFlight.promise;
    }

    const startedAt = now();
    const flight: InFlightRefresh = {
      key,
      invalidated: false,
      promise: Promise.resolve(""),
    };

    flight.promise = (async () => {
      try {
        const result = await requestMachineToken({
          ...cfg,
          scope: options.scope,
          fetch: options.fetch,
        });
        if (!flight.invalidated) {
          cached = {
            key,
            accessToken: result.accessToken,
            expiresAt: startedAt + result.expiresIn * 1000,
          };
        }
        return result.accessToken;
      } finally {
        if (inFlight === flight) {
          inFlight = null;
        }
      }
    })();

    inFlight = flight;
    return flight.promise;
  }

  return { getAccessToken, clear };
}
