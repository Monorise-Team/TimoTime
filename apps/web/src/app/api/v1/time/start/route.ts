import { StartTimeEntryInput } from "@timotime/contracts";
import { readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { startTimeEntry } from "@/server/time-entries";

export const dynamic = "force-dynamic";

export const POST = route(
  async ({ request }) => {
    const caller = await requireUser(request);
    const input = StartTimeEntryInput.parse(await readJson(request));
    return startTimeEntry(caller, input);
  },
  { status: 201 },
);
