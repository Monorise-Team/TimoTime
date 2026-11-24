import { route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { getCurrentProfile } from "@/server/core";
import { getUserCapabilities } from "@/server/permissions";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const caller = await requireUser(request);
  const profile = await getCurrentProfile(caller);
  const capabilities = await getUserCapabilities(caller);
  return { ...profile, capabilities };
});
