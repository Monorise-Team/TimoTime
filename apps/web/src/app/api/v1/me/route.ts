import { route } from "@/server/api";
import { getCurrentProfile } from "@/server/core";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => getCurrentProfile(request));
