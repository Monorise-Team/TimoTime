/**
 * Rejestracja manifestu uprawnień i gotowych ról (szablonów) TimoTime w MonoriseCore.
 *
 * Moduł celowo nie importuje `server-only`, aby mogło z niego korzystać narzędzie CLI
 * (`pnpm permissions:register`). Używa wyłącznie składni usuwalnej typów TypeScript, dzięki czemu
 * Node 24 uruchamia go bezpośrednio bez dodatkowego kompilatora.
 */
import { existsSync, readFileSync } from "node:fs";
import { TIMOTIME_PERMISSION_MANIFEST, TIMOTIME_PERMISSIONS, TIMOTIME_ROLE_TEMPLATES } from "@timotime/contracts";
import { z } from "zod";
import { CORE_PERMISSIONS_REGISTER_SCOPE, CoreMachineTokenError, requestMachineToken } from "./core-machine.ts";

export { CORE_PERMISSIONS_REGISTER_SCOPE };
export const TIMOTIME_PRODUCT_KEY = TIMOTIME_PERMISSIONS.product;

export type RegistrationStep = "config" | "token" | "permissions" | "roleTemplates";

export interface CoreApiErrorDetail {
  field?: string;
  message: string;
}

export class CoreRegistrationError extends Error {
  readonly step: RegistrationStep;
  readonly status?: number;
  readonly code?: string;
  readonly details: readonly CoreApiErrorDetail[];

  constructor(
    step: RegistrationStep,
    message: string,
    options?: {
      status?: number;
      code?: string;
      details?: readonly CoreApiErrorDetail[];
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "CoreRegistrationError";
    this.step = step;
    this.status = options?.status;
    this.code = options?.code;
    this.details = options?.details ?? [];
  }
}

export const RegisterPermissionsSummarySchema = z.object({
  added: z.array(z.string()),
  updated: z.array(z.string()),
  deprecated: z.array(z.string()),
  restored: z.array(z.string()),
  unchanged: z.number().int().nonnegative(),
});
export type RegisterPermissionsSummary = z.infer<typeof RegisterPermissionsSummarySchema>;

export const RegisterRoleTemplatesSummarySchema = z.object({
  added: z.array(z.string()),
  updated: z.array(z.string()),
  archived: z.array(z.string()),
  restored: z.array(z.string()),
  unchanged: z.number().int().nonnegative(),
});
export type RegisterRoleTemplatesSummary = z.infer<typeof RegisterRoleTemplatesSummarySchema>;

const CoreErrorEnvelopeSchema = z.object({
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
      details: z
        .array(
          z.object({
            field: z.string().optional(),
            message: z.string(),
          }),
        )
        .optional(),
    })
    .nullable()
    .optional(),
});

export interface CoreRegistrationConfig {
  coreAuthUrl: string;
  coreApiUrl: string;
  clientId: string;
  clientSecret: string;
}

export type RegistrationStepEvent =
  | { step: "token"; clientId: string }
  | { step: "permissions"; summary: RegisterPermissionsSummary }
  | { step: "roleTemplates"; summary: RegisterRoleTemplatesSummary };

export interface RegisterWithCoreOptions extends CoreRegistrationConfig {
  fetch?: typeof globalThis.fetch;
  onStep?: (event: RegistrationStepEvent) => void;
}

export interface RegisterWithCoreResult {
  permissions: RegisterPermissionsSummary;
  roleTemplates: RegisterRoleTemplatesSummary;
}

/** Odczytuje pary klucz=wartość z treści pliku `.env.local` (pomija komentarze i puste linie). */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const line = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (!key) continue;
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
    }
    result[key] = value;
  }
  return result;
}

/**
 * Składa konfigurację rejestracji ze zmiennych środowiskowych z lokalnym fallbackiem do pliku
 * `.env.local`. Zmienne obecne w `env` zawsze mają pierwszeństwo przed plikiem.
 */
export function resolveRegistrationConfig(
  env: Record<string, string | undefined>,
  options?: { envFilePath?: string },
): CoreRegistrationConfig {
  const fileValues =
    options?.envFilePath && existsSync(options.envFilePath)
      ? parseDotEnv(readFileSync(options.envFilePath, "utf8"))
      : {};
  const read = (name: string): string => {
    const value = env[name] !== undefined ? env[name] : fileValues[name];
    return (value ?? "").trim();
  };
  return {
    coreAuthUrl: read("CORE_AUTH_URL"),
    coreApiUrl: read("CORE_API_URL"),
    clientId: read("TIMOTIME_OAUTH_CLIENT_ID"),
    clientSecret: read("TIMOTIME_OAUTH_CLIENT_SECRET"),
  };
}

function normalizeHttpUrl(raw: string, envName: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CoreRegistrationError("config", `Nieprawidłowy adres URL w zmiennej ${envName}.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CoreRegistrationError("config", `Adres w zmiennej ${envName} musi używać protokołu http lub https.`);
  }
  return trimmed;
}

function validateConfig(options: CoreRegistrationConfig): CoreRegistrationConfig {
  const missing: string[] = [];
  if (!options.coreAuthUrl.trim()) missing.push("CORE_AUTH_URL");
  if (!options.coreApiUrl.trim()) missing.push("CORE_API_URL");
  if (!options.clientId.trim()) missing.push("TIMOTIME_OAUTH_CLIENT_ID");
  if (!options.clientSecret.trim()) missing.push("TIMOTIME_OAUTH_CLIENT_SECRET");

  if (missing.length > 0) {
    throw new CoreRegistrationError(
      "config",
      `Brak wymaganej konfiguracji rejestracji w MonoriseCore: ${missing.join(", ")}. ` +
        "Ustaw zmienne środowiskowe albo uzupełnij plik apps/web/.env.local (pnpm setup:env).",
    );
  }

  return {
    coreAuthUrl: normalizeHttpUrl(options.coreAuthUrl, "CORE_AUTH_URL"),
    coreApiUrl: normalizeHttpUrl(options.coreApiUrl, "CORE_API_URL"),
    clientId: options.clientId.trim(),
    clientSecret: options.clientSecret.trim(),
  };
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function requestRegistrationToken(
  config: CoreRegistrationConfig,
  fetchFn: typeof globalThis.fetch,
): Promise<string> {
  try {
    const result = await requestMachineToken({
      ...config,
      scope: CORE_PERMISSIONS_REGISTER_SCOPE,
      fetch: fetchFn,
    });
    return result.accessToken;
  } catch (error) {
    if (error instanceof CoreMachineTokenError) {
      throw new CoreRegistrationError("token", error.message, {
        status: error.status,
        code: error.code,
        cause: error,
      });
    }
    throw error;
  }
}

function formatApiErrorMessage(
  label: string,
  status: number,
  code: string | undefined,
  message: string | undefined,
  details: readonly CoreApiErrorDetail[],
): string {
  const headerParts = [`HTTP ${status}`];
  if (code) headerParts.push(code);
  const headline = message
    ? `Błąd Core API podczas ${label} (${headerParts.join(", ")}): ${message}`
    : `Błąd Core API podczas ${label} (${headerParts.join(", ")}).`;

  if (details.length === 0) return headline;
  const formattedDetails = details.map((detail) =>
    detail.field ? `  * ${detail.field}: ${detail.message}` : `  * ${detail.message}`,
  );
  return `${headline}\nSzczegóły:\n${formattedDetails.join("\n")}`;
}

const CoreSuccessEnvelopeSchema = z.object({
  data: z.unknown(),
  error: z.null().optional(),
});

async function putCoreRegistry<TData>(options: {
  step: "permissions" | "roleTemplates";
  label: string;
  url: string;
  accessToken: string;
  body: unknown;
  dataSchema: z.ZodType<TData>;
  fetchFn: typeof globalThis.fetch;
}): Promise<TData> {
  let response: Response;
  try {
    response = await options.fetchFn(options.url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(options.body),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CoreRegistrationError(
      options.step,
      `Nie udało się połączyć z Core API podczas ${options.label} (${options.url}): ${reason}`,
      { cause: error },
    );
  }

  const payload = await readJsonSafely(response);
  if (!response.ok) {
    const parsedError = CoreErrorEnvelopeSchema.safeParse(payload);
    const apiError = parsedError.success ? parsedError.data.error : null;
    const code = apiError?.code;
    const message = apiError?.message;
    const details = apiError?.details ?? [];
    throw new CoreRegistrationError(
      options.step,
      formatApiErrorMessage(options.label, response.status, code, message, details),
      {
        status: response.status,
        code,
        details,
      },
    );
  }

  const envelope = CoreSuccessEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    throw new CoreRegistrationError(
      options.step,
      `Core API zwróciło nieoczekiwany format odpowiedzi podczas ${options.label} (HTTP ${response.status}).`,
      { status: response.status },
    );
  }

  const parsed = options.dataSchema.safeParse(envelope.data.data);
  if (!parsed.success) {
    throw new CoreRegistrationError(
      options.step,
      `Core API zwróciło nieoczekiwany format odpowiedzi podczas ${options.label} (HTTP ${response.status}).`,
      { status: response.status },
    );
  }

  return parsed.data;
}

/**
 * Pobiera token maszynowy OAuth 2.1 (`client_credentials`, zakres `core:permissions.register`),
 * rejestruje manifest uprawnień TimoTime, a następnie gotowe role (szablony) w MonoriseCore.
 */
export async function registerWithCore(options: RegisterWithCoreOptions): Promise<RegisterWithCoreResult> {
  const config = validateConfig(options);
  const fetchFn = options.fetch ?? globalThis.fetch;

  const accessToken = await requestRegistrationToken(config, fetchFn);
  options.onStep?.({ step: "token", clientId: config.clientId });

  const permissions = await putCoreRegistry({
    step: "permissions",
    label: "rejestracji manifestu uprawnień",
    url: `${config.coreApiUrl}/core/v1/products/${TIMOTIME_PRODUCT_KEY}/permissions`,
    accessToken,
    body: TIMOTIME_PERMISSION_MANIFEST,
    dataSchema: RegisterPermissionsSummarySchema,
    fetchFn,
  });
  options.onStep?.({ step: "permissions", summary: permissions });

  const roleTemplates = await putCoreRegistry({
    step: "roleTemplates",
    label: "rejestracji gotowych ról",
    url: `${config.coreApiUrl}/core/v1/products/${TIMOTIME_PRODUCT_KEY}/role-templates`,
    accessToken,
    body: TIMOTIME_ROLE_TEMPLATES,
    dataSchema: RegisterRoleTemplatesSummarySchema,
    fetchFn,
  });
  options.onStep?.({ step: "roleTemplates", summary: roleTemplates });

  return { permissions, roleTemplates };
}

function formatKeyList(label: string, keys: readonly string[]): string {
  return keys.length > 0 ? `${label} ${keys.length} (${keys.join(", ")})` : `${label} 0`;
}

/** Formatuje krótki polski opis kroku rejestracji do wypisania w terminalu lub logu wdrożenia. */
export function formatRegistrationStep(event: RegistrationStepEvent): string {
  if (event.step === "token") {
    return `1/3 Token maszynowy pobrany dla klienta ${event.clientId}.`;
  }
  if (event.step === "permissions") {
    const { added, updated, deprecated, restored, unchanged } = event.summary;
    return (
      `2/3 Uprawnienia (${TIMOTIME_PRODUCT_KEY}): ` +
      [
        formatKeyList("dodano", added),
        formatKeyList("zaktualizowano", updated),
        formatKeyList("wycofano", deprecated),
        formatKeyList("przywrócono", restored),
        `bez zmian ${unchanged}`,
      ].join(", ") +
      "."
    );
  }
  const { added, updated, archived, restored, unchanged } = event.summary;
  return (
    `3/3 Gotowe role (${TIMOTIME_PRODUCT_KEY}): ` +
    [
      formatKeyList("dodano", added),
      formatKeyList("zaktualizowano", updated),
      formatKeyList("zarchiwizowano", archived),
      formatKeyList("przywrócono", restored),
      `bez zmian ${unchanged}`,
    ].join(", ") +
    "."
  );
}
