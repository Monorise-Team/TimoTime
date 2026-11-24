import { route } from "@/server/api";

export const dynamic = "force-dynamic";

/** Czy serwer działa; bez sprawdzania bazy i Core (do monitoringu). */
export const GET = route(async () => ({ status: "ok", version: process.env.npm_package_version ?? null }));
