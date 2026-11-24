import { route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { getTeamCurrentEntries } from "@/server/team-entries";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const caller = await requireUser(request);
  return getTeamCurrentEntries(caller);
});
