import { route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { getCurrentTimeEntry } from "@/server/time-entries";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const caller = await requireUser(request);
  return getCurrentTimeEntry(caller);
});
