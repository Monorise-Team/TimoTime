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
  audience = [API, `${CORE}/api/auth/oauth2/userinfo`],
  expiresIn = "5m",
}: {
  accountId: string;
  organizationId: string;
  employeeId?: string;
  audience?: string | string[];
  expiresIn?: string;
}): Promise<string> {
  return new SignJWT({
    org_id: organizationId,
    employee_id: employeeId,
    authz_rev: 0,
    sid: "sesja-core",
    client_id: "timotime-mobile",
    scope: "openid profile email offline_access",
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "test", typ: "at+jwt" })
    .setIssuer(CORE)
    .setSubject(accountId)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey);
}
