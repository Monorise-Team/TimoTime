import { SessionExpiredError, type AppTokens, type SignInProvider } from "@timotime/client";
import * as AuthSession from "expo-auth-session";
import Constants from "expo-constants";

const extra = Constants.expoConfig?.extra as
  { apiResource?: string; coreAuthUrl?: string; coreApiUrl?: string } | undefined;
const CORE = extra?.coreAuthUrl ?? "http://localhost:3100";
const RESOURCE = extra?.apiResource ?? "http://time.localhost:3300";
export const CORE_API = extra?.coreApiUrl ?? "http://localhost:3200";
const CLIENT_ID = "timotime-mobile";
const SCOPES = ["openid", "profile", "email", "offline_access"];

const discovery: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: `${CORE}/api/auth/oauth2/authorize`,
  tokenEndpoint: `${CORE}/api/auth/oauth2/token`,
  revocationEndpoint: `${CORE}/api/auth/oauth2/revoke`,
};

/** Powrót do aplikacji: `timotime://oauth/callback`, a w Expo Go adres `exp://` serwera Metro. */
const redirectUri = AuthSession.makeRedirectUri({ scheme: "timotime", path: "oauth/callback" });

function toTokens(response: AuthSession.TokenResponse, previousRefreshToken?: string): AppTokens {
  const refreshToken = response.refreshToken ?? previousRefreshToken;
  if (!refreshToken) throw new Error("Core nie wydał tokenu odświeżania");
  const expiresIn = response.expiresIn ?? 300;
  return { accessToken: response.accessToken, refreshToken, expiresAt: (response.issuedAt + expiresIn) * 1000 };
}

/**
 * Logowanie kontem Monorise na telefonie (RFC 8252): ekran logowania Core w przeglądarce systemowej
 * (ASWebAuthenticationSession, Custom Tabs), powrót do aplikacji, wymiana kodu z PKCE. Expo sprawdza `state`.
 * Żądanie autoryzacji prosi o oba zasoby (API TimoTime i Core API), żeby telefon mógł pobierać token Core API
 * przez refresh grant bez przekazywania tokenu TimoTime do Core.
 */
export const mobileSignIn: SignInProvider = {
  async signIn() {
    const request = new AuthSession.AuthRequest({
      clientId: CLIENT_ID,
      redirectUri,
      scopes: SCOPES,
      usePKCE: true,
      extraParams: { resource: RESOURCE },
    });
    // expo-auth-session nie pozwala powtórzyć parametru resource w extraParams, więc doklejamy Core API do URL.
    const baseUrl = await request.makeAuthUrlAsync(discovery);
    const url = `${baseUrl}&resource=${encodeURIComponent(CORE_API)}`;
    const result = await request.promptAsync(discovery, { url });
    if (result.type === "cancel" || result.type === "dismiss") throw new Error("Logowanie zostało przerwane.");
    if (result.type !== "success") throw new Error("Nie udało się zalogować.");
    // RFC 9207: odpowiedź musi pochodzić od Core
    if (result.params.iss !== CORE) throw new Error("Odpowiedź logowania nie pochodzi z Monorise.");
    const response = await AuthSession.exchangeCodeAsync(
      {
        clientId: CLIENT_ID,
        code: result.params.code ?? "",
        redirectUri,
        extraParams: { code_verifier: request.codeVerifier ?? "", resource: RESOURCE },
      },
      discovery,
    );
    return toTokens(response);
  },

  async refresh(refreshToken, resource = RESOURCE) {
    try {
      const response = await AuthSession.refreshAsync(
        { clientId: CLIENT_ID, refreshToken, extraParams: { resource } },
        discovery,
      );
      return toTokens(response, refreshToken);
    } catch (error) {
      if (error instanceof AuthSession.TokenError && error.code === "invalid_grant") throw new SessionExpiredError();
      throw error;
    }
  },

  async revoke(refreshToken) {
    await AuthSession.revokeAsync(
      { clientId: CLIENT_ID, token: refreshToken, tokenTypeHint: AuthSession.TokenTypeHint.RefreshToken },
      discovery,
    );
  },
};
