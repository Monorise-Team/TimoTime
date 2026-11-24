import { StopTimeEntryInput } from "@timotime/contracts";
import { readOptionalJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { stopTimeEntry } from "@/server/time-entries";

export const dynamic = "force-dynamic";

export const POST = route(async ({ request }) => {
  const caller = await requireUser(request);
  const input = StopTimeEntryInput.parse(await readOptionalJson(request));
  return stopTimeEntry(caller, input);
});
