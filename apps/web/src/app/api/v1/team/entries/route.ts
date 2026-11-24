import { TimeEntriesQuery } from "@timotime/contracts";
import { route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { listTeamTimeEntries } from "@/server/team-entries";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const caller = await requireUser(request);
  const params = request.nextUrl.searchParams;
  const query = TimeEntriesQuery.parse({
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
  });
  return listTeamTimeEntries(caller, query);
});
