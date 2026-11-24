import type { TeamTimeEntry, TimeEntry } from "@timotime/contracts";
import { describe, expect, it } from "vitest";
import { groupEntriesByDay, groupTeamEntriesByEmployee, localDateKey } from "@/lib/time-format";

function makeEntry(overrides: {
  id: string;
  kind: TimeEntry["kind"];
  startedAt: Date;
  endedAt: Date | null;
}): TimeEntry {
  return {
    id: overrides.id,
    organizationId: "org-1",
    accountId: "acc-1",
    employeeId: "emp-1",
    kind: overrides.kind,
    startedAt: overrides.startedAt.toISOString(),
    endedAt: overrides.endedAt ? overrides.endedAt.toISOString() : null,
    note: null,
    createdAt: overrides.startedAt.toISOString(),
    updatedAt: overrides.startedAt.toISOString(),
  };
}

describe("grupowanie wpisów według lokalnych dni z podziałem o północy", () => {
  it("dzieli zmianę nocną 22:00-02:00 między dwa dni i liczy po 2 godziny w każdym dniu", () => {
    const start = new Date(2026, 10, 23, 22, 0, 0, 0);
    const end = new Date(2026, 10, 24, 2, 0, 0, 0);
    const entry = makeEntry({ id: "night", kind: "WORK", startedAt: start, endedAt: end });

    const groups = groupEntriesByDay([entry], end.getTime());
    expect(groups.map((group) => group.dateKey)).toEqual([localDateKey(end), localDateKey(start)]);

    const nextDay = groups[0]!;
    const prevDay = groups[1]!;
    expect(nextDay.workMs).toBe(2 * 60 * 60 * 1000);
    expect(nextDay.entries[0]?.startedBeforeDay).toBe(true);
    expect(nextDay.entries[0]?.endedAfterDay).toBe(false);

    expect(prevDay.workMs).toBe(2 * 60 * 60 * 1000);
    expect(prevDay.entries[0]?.startedBeforeDay).toBe(false);
    expect(prevDay.entries[0]?.endedAfterDay).toBe(true);
  });

  it("dla widoku jednego dnia liczy wyłącznie część wpisu mieszczącą się w tym dniu", () => {
    const night = makeEntry({
      id: "night",
      kind: "WORK",
      startedAt: new Date(2026, 10, 23, 22, 0, 0, 0),
      endedAt: new Date(2026, 10, 24, 2, 0, 0, 0),
    });
    const brk = makeEntry({
      id: "break",
      kind: "BREAK",
      startedAt: new Date(2026, 10, 24, 10, 0, 0, 0),
      endedAt: new Date(2026, 10, 24, 10, 30, 0, 0),
    });
    const remote = makeEntry({
      id: "remote",
      kind: "REMOTE",
      startedAt: new Date(2026, 10, 24, 11, 0, 0, 0),
      endedAt: new Date(2026, 10, 24, 12, 0, 0, 0),
    });
    const dayStart = new Date(2026, 10, 24, 0, 0, 0, 0);
    const dayEnd = new Date(2026, 10, 24, 23, 59, 59, 999);

    const groups = groupEntriesByDay([remote, brk, night], dayEnd.getTime(), {
      from: dayStart.toISOString(),
      to: dayEnd.toISOString(),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.dateKey).toBe("2026-11-24");
    // 2 godz. z nocnego WORK + 1 godz. z REMOTE = 3 godz., przerwa 30 min osobno
    expect(groups[0]?.workMs).toBe(3 * 60 * 60 * 1000);
    expect(groups[0]?.breakMs).toBe(30 * 60 * 1000);
  });

  it("nie tworzy pustego wpisu na kolejny dzień, gdy wpis kończy się równo o 00:00", () => {
    const entry = makeEntry({
      id: "midnight",
      kind: "WORK",
      startedAt: new Date(2026, 10, 23, 22, 0, 0, 0),
      endedAt: new Date(2026, 10, 24, 0, 0, 0, 0),
    });
    const groups = groupEntriesByDay([entry], new Date(2026, 10, 24, 12, 0, 0, 0).getTime());
    expect(groups).toHaveLength(1);
    expect(groups[0]?.dateKey).toBe("2026-11-23");
    expect(groups[0]?.workMs).toBe(2 * 60 * 60 * 1000);
  });
});

describe("grupowanie wpisów zespołu według pracownika", () => {
  function makeTeamEntry(overrides: {
    id: string;
    employeeId: string;
    firstName: string;
    lastName: string;
    kind: TeamTimeEntry["kind"];
    startedAt: Date;
    endedAt: Date | null;
  }): TeamTimeEntry {
    return {
      ...makeEntry({
        id: overrides.id,
        kind: overrides.kind,
        startedAt: overrides.startedAt,
        endedAt: overrides.endedAt,
      }),
      employeeId: overrides.employeeId,
      employee: {
        id: overrides.employeeId,
        firstName: overrides.firstName,
        lastName: overrides.lastName,
      },
    };
  }

  it("liczy sumy pracy i przerw na osobę, przycina zmianę nocną do dnia i sortuje alfabetycznie", () => {
    const dayStart = new Date(2026, 10, 24, 0, 0, 0, 0);
    const dayEnd = new Date(2026, 10, 24, 23, 59, 59, 999);
    const nowMs = new Date(2026, 10, 24, 12, 0, 0, 0).getTime();

    const groups = groupTeamEntriesByEmployee(
      [
        makeTeamEntry({
          id: "anna-night",
          employeeId: "emp-anna",
          firstName: "Anna",
          lastName: "Nowak",
          kind: "WORK",
          startedAt: new Date(2026, 10, 23, 22, 0, 0, 0),
          endedAt: new Date(2026, 10, 24, 2, 0, 0, 0),
        }),
        makeTeamEntry({
          id: "anna-break",
          employeeId: "emp-anna",
          firstName: "Anna",
          lastName: "Nowak",
          kind: "BREAK",
          startedAt: new Date(2026, 10, 24, 10, 0, 0, 0),
          endedAt: new Date(2026, 10, 24, 10, 30, 0, 0),
        }),
        makeTeamEntry({
          id: "marek-open",
          employeeId: "emp-marek",
          firstName: "Marek",
          lastName: "Kowalski",
          kind: "REMOTE",
          startedAt: new Date(2026, 10, 24, 9, 0, 0, 0),
          endedAt: null,
        }),
      ],
      nowMs,
      { from: dayStart.toISOString(), to: dayEnd.toISOString() },
    );

    expect(groups.map((g) => g.fullName)).toEqual(["Marek Kowalski", "Anna Nowak"]);
    expect(groups[0]?.workMs).toBe(3 * 60 * 60 * 1000);
    expect(groups[0]?.breakMs).toBe(0);
    expect(groups[1]?.workMs).toBe(2 * 60 * 60 * 1000);
    expect(groups[1]?.breakMs).toBe(30 * 60 * 1000);
    expect(groups[1]?.entries.find((s) => s.entry.id === "anna-night")?.startedBeforeRange).toBe(true);
  });
});
