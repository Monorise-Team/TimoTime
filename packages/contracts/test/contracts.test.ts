import { permissionManifestSchema } from "@monorise-team/permissions";
import { describe, expect, it } from "vitest";
import {
  resolveEntriesRange,
  StartTimeEntryInput,
  TIME_ENTRY_KINDS,
  TIMOTIME_PERMISSION_MANIFEST,
  TIMOTIME_PERMISSIONS,
  TimeEntriesQuery,
} from "../src/index.js";

describe("manifest uprawnień TimoTime", () => {
  it("spełnia schemat manifestu z @monorise-team/permissions", () => {
    const parsed = permissionManifestSchema.parse(TIMOTIME_PERMISSION_MANIFEST);
    expect(parsed).toHaveLength(6);
    expect(TIMOTIME_PERMISSIONS.product).toBe("timotime");
  });

  it("zawiera wszystkie uprawnienia z karty produktu i opisy po polsku", () => {
    expect(Object.values(TIMOTIME_PERMISSIONS.keys)).toEqual([
      "timotime.entries.read_own",
      "timotime.entries.write_own",
      "timotime.entries.read",
      "timotime.entries.approve",
      "timotime.leave.approve",
      "timotime.reports.export",
    ]);
    for (const entry of TIMOTIME_PERMISSION_MANIFEST) {
      expect(entry.key.startsWith("timotime.")).toBe(true);
      expect(entry.description.length).toBeGreaterThan(10);
    }
  });
});

describe("schematy czasu pracy", () => {
  it("przyjmuje wszystkie rodzaje wpisu i przycina notatkę", () => {
    for (const kind of TIME_ENTRY_KINDS) {
      expect(StartTimeEntryInput.parse({ kind, note: "  Spotkanie  " })).toEqual({ kind, note: "Spotkanie" });
    }
    expect(StartTimeEntryInput.parse({ kind: "WORK", note: "   " })).toEqual({ kind: "WORK", note: undefined });
  });

  it("odrzuca nieznany rodzaj wpisu i zbyt długą notatkę", () => {
    expect(StartTimeEntryInput.safeParse({ kind: "VACATION" }).success).toBe(false);
    expect(StartTimeEntryInput.safeParse({ kind: "WORK", note: "a".repeat(501) }).success).toBe(false);
  });

  it("domyślny zakres wpisów to dzisiejszy dzień w UTC", () => {
    const now = new Date("2026-11-24T14:20:00.000Z");
    const range = resolveEntriesRange({}, now);
    expect(range.from.toISOString()).toBe("2026-11-24T00:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-11-24T23:59:59.999Z");
  });

  it("odrzuca zakres dłuższy niż 31 dni, odwrócony albo niepoprawne daty", () => {
    expect(TimeEntriesQuery.safeParse({ from: "2026-11-01", to: "2026-11-30" }).success).toBe(true);
    expect(TimeEntriesQuery.safeParse({ from: "2026-11-01", to: "2026-12-03" }).success).toBe(false);
    expect(TimeEntriesQuery.safeParse({ from: "2026-11-24", to: "2026-11-20" }).success).toBe(false);
    expect(TimeEntriesQuery.safeParse({ from: "2026-02-31", to: "2026-03-01" }).success).toBe(false);
    expect(TimeEntriesQuery.safeParse({ from: "nie-data" }).success).toBe(false);
  });
});
