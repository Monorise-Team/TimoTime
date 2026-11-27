import type { TimeEntry } from "@timotime/contracts";
import { describe, expect, it } from "vitest";
import {
  buildSignInHref,
  formatStartToastTitle,
  formatStopToastTitle,
  parseReminderDeepLink,
  parseViewFromHash,
} from "@/app/app/app-views";
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

describe("głębokie linki z przypomnień e-mail", () => {
  it("rozpoznaje poprawne parametry date, entry oraz view=week i odrzuca błędne", () => {
    expect(parseReminderDeepLink("?date=2026-11-20")).toEqual({
      tab: "today",
      date: "2026-11-20",
      entryId: null,
      week: null,
    });
    expect(parseReminderDeepLink("?entry=019a0000-0000-7000-8000-000000000001")).toEqual({
      tab: "today",
      date: null,
      entryId: "019a0000-0000-7000-8000-000000000001",
      week: null,
    });
    expect(parseReminderDeepLink("?view=week&week=2026-W47")).toEqual({
      tab: "week",
      date: null,
      entryId: null,
      week: "2026-W47",
    });
    expect(parseReminderDeepLink("?date=2026-02-31&week=bad")).toEqual({
      tab: "today",
      date: null,
      entryId: null,
      week: null,
    });
  });

  it("zachowuje parametry głębokiego linku w adresie logowania bez auth_error i bez otwartych przekierowań", () => {
    expect(buildSignInHref({ pathname: "/", search: "?date=2026-11-20&auth_error=expired", hash: "#moj-czas" })).toBe(
      "/api/auth/sign-in?returnTo=%2F%3Fdate%3D2026-11-20%23moj-czas",
    );
    expect(buildSignInHref({ pathname: "//evil.test/phish", search: "", hash: "" })).toBe(
      "/api/auth/sign-in?returnTo=%2F",
    );
  });
});
