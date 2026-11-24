import { getAuth } from "@/server/auth";

export const dynamic = "force-dynamic";

/** Przekierowanie na logowanie w Core (`?returnTo=/ścieżka`, opcjonalnie `prompt=login`). */
export const GET = (request: Request) => getAuth().signIn(request);
