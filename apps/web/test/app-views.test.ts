import type { TimeEntry } from "@timotime/contracts";
import { describe, expect, it } from "vitest";
import { formatStartToastTitle, formatStopToastTitle, parseViewFromHash } from "@/app/app/app-views";
import { formatTime } from "@/lib/time-format";

describe("rozpoznawanie widoku z fragmentu adresu (hash)", () => {
  it("domyślnie i dla nieznanych fragmentów wybiera widok Mój czas", () => {
    expect(parseViewFromHash("", { canViewTeam: false })).toBe("my-time");
    expect(parseViewFromHash("#moj-czas", { canViewTeam: true })).toBe("my-time");
    expect(parseViewFromHash("#nieznany", { canViewTeam: true })).toBe("my-time");
  });

  it("otwiera widok Zespół tylko przy uprawnieniu viewTeam", () => {
    expect(parseViewFromHash("#zespol", { canViewTeam: true })).toBe("team");
    expect(parseViewFromHash("#ZESPOL", { canViewTeam: true })).toBe("team");
    expect(parseViewFromHash("#zespol", { canViewTeam: false })).toBe("my-time");
  });

  it("otwiera widok Wygląd niezależnie od uprawnienia zespołu", () => {
    expect(parseViewFromHash("#wyglad", { canViewTeam: false })).toBe("appearance");
    expect(parseViewFromHash("#wyglad", { canViewTeam: true })).toBe("appearance");
  });

  it("dla osoby z samym dostępem do zespołu domyślnie otwiera Zespół", () => {
    expect(parseViewFromHash("", { canViewTeam: true, canTrackOwn: false })).toBe("team");
    expect(parseViewFromHash("#moj-czas", { canViewTeam: true, canTrackOwn: false })).toBe("my-time");
  });
});

describe("komunikaty powiadomień po starcie i stopie", () => {
  it("formatuje powiadomienie po rozpoczęciu wpisu z lokalną godziną", () => {
    const startedAt = new Date(2026, 10, 25, 9, 2, 0, 0).toISOString();
    expect(formatStartToastTitle({ kind: "WORK", startedAt })).toBe(`Praca rozpoczęta o ${formatTime(startedAt)}`);
    expect(formatStartToastTitle({ kind: "BREAK", startedAt })).toBe(`Przerwa rozpoczęta o ${formatTime(startedAt)}`);
    expect(formatStartToastTitle({ kind: "REMOTE", startedAt })).toBe(
      `Praca zdalna rozpoczęta o ${formatTime(startedAt)}`,
    );
    expect(formatStartToastTitle({ kind: "BUSINESS_TRIP", startedAt })).toBe(
      `Wyjście służbowe rozpoczęte o ${formatTime(startedAt)}`,
    );
  });

  it("formatuje powiadomienie po zakończeniu wpisu z czasem trwania", () => {
    const start = new Date(2026, 10, 25, 9, 0, 0, 0);
    const end = new Date(2026, 10, 25, 10, 12, 0, 0);
    const entry: TimeEntry = {
      id: "entry-1",
      organizationId: "org-1",
      accountId: "acc-1",
      employeeId: "emp-1",
      kind: "WORK",
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      note: null,
      createdAt: start.toISOString(),
      updatedAt: end.toISOString(),
    };
    expect(formatStopToastTitle(entry, end.getTime())).toBe("Zakończono: 1 godz. 12 min");
  });
});
