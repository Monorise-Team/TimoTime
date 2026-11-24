/**
 * Klucz „Core” do testów: generowany przy każdym uruchomieniu. Klucz publiczny trafia do TIMOTIME_CORE_JWKS
 * (serwer sprawdza nim tokeny zamiast pobierać JWKS z Core), a prywatnym testy podpisują tokeny.
 */
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
process.env.TIMOTIME_CORE_JWKS = JSON.stringify({
  keys: [{ ...(await exportJWK(publicKey)), kid: "test", alg: "EdDSA" }],
});

export const CORE = "http://localhost:3100";
export const API = "http://time.localhost:3300";

/** Token dostępu jak z MonoriseCore (ADR-0023): `at+jwt`, EdDSA, odbiorca API TimoTime. */
export function coreToken({
  accountId,
  organizationId,
  employeeId = crypto.randomUUID(),
  authzRevision = 0,
  issuer = process.env.CORE_AUTH_URL ?? CORE,
  audience = [API, `${issuer}/api/auth/oauth2/userinfo`],
  expiresIn = "5m",
}: {
  accountId: string;
  organizationId: string;
  employeeId?: string;
  authzRevision?: number;
  issuer?: string;
  audience?: string | string[];
  expiresIn?: string;
}): Promise<string> {
  return new SignJWT({
    org_id: organizationId,
    employee_id: employeeId,
    authz_rev: authzRevision,
    sid: "sesja-core",
    client_id: "timotime-mobile",
    scope: "openid profile email offline_access",
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "test", typ: "at+jwt" })
    .setIssuer(issuer)
    .setSubject(accountId)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey);
}
