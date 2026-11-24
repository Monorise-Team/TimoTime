import { getAuth } from "@/server/auth";

export const dynamic = "force-dynamic";

/** Wylogowanie z TimoTime (tylko POST z adresu aplikacji); unieważnia token odświeżania w Core. */
export const POST = (request: Request) => getAuth().signOut(request);
