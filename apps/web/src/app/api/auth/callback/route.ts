import { getAuth } from "@/server/auth";

export const dynamic = "force-dynamic";

/** Powrót z Core z kodem: sesja w bazie TimoTime, ciasteczko HttpOnly i powrót pod returnTo. */
export const GET = (request: Request) => getAuth().callback(request);
