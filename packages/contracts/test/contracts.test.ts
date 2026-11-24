import { permissionKeySchema, permissionManifestSchema } from "@monorise-team/permissions";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Me,
  resolveEntriesRange,
  StartTimeEntryInput,
  TeamCurrentList,
  TeamTimeEntriesList,
  TIME_ENTRY_KINDS,
  TIMOTIME_PERMISSION_MANIFEST,
  TIMOTIME_PERMISSIONS,
  TIMOTIME_ROLE_TEMPLATES,
  TimeEntriesQuery,
} from "../src/index.js";

/** Minimalny schemat żądania `PUT /core/v1/products/{productKey}/role-templates` zgodny z MonoriseCore. */
const CoreRoleTemplateKey = z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/);
const CoreRoleTemplateEntry = z.object({
  key: CoreRoleTemplateKey,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500).nullable().optional(),
  permissions: z
    .array(permissionKeySchema)
    .min(1)
    .max(200)
    .refine((keys) => new Set(keys).size === keys.length, "Zduplikowane klucze uprawnień w roli"),
});
const CoreRegisterRoleTemplatesRequest = z
  .array(CoreRoleTemplateEntry)
  .max(100)
  .refine((entries) => new Set(entries.map((entry) => entry.key)).size === entries.length, "Zduplikowane klucze ról");

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

describe("gotowe role (szablony) TimoTime", () => {
  it("spełniają schemat żądania MonoriseCore i mają prefiks timotime.", () => {
    const parsed = CoreRegisterRoleTemplatesRequest.parse(TIMOTIME_ROLE_TEMPLATES);
    expect(parsed).toHaveLength(2);
    for (const template of parsed) {
      expect(template.key.startsWith("timotime.")).toBe(true);
    }
  });

  it("odwołują się wyłącznie do uprawnień z manifestu TimoTime", () => {
    const manifestKeys = new Set<string>(TIMOTIME_PERMISSION_MANIFEST.map((entry) => entry.key));
    for (const template of TIMOTIME_ROLE_TEMPLATES) {
      for (const permission of template.permissions) {
        expect(manifestKeys.has(permission)).toBe(true);
      }
    }
  });

  it("definiują role Pracownik i Kierownik z oczekiwanym zakresem uprawnień", () => {
    const byKey = new Map<string, (typeof TIMOTIME_ROLE_TEMPLATES)[number]>(
      TIMOTIME_ROLE_TEMPLATES.map((template) => [template.key, template]),
    );

    expect(byKey.get("timotime.employee")).toEqual({
      key: "timotime.employee",
      name: "Pracownik",
      description: "Rejestruje i przegląda własny czas pracy",
      permissions: ["timotime.entries.read_own", "timotime.entries.write_own"],
    });

    expect(byKey.get("timotime.manager")).toEqual({
      key: "timotime.manager",
      name: "Kierownik",
      description: "Przegląda i zatwierdza czas pracy, urlopy i raporty zespołu w swoim zakresie",
      permissions: [
        "timotime.entries.read_own",
        "timotime.entries.write_own",
        "timotime.entries.read",
        "timotime.entries.approve",
        "timotime.leave.approve",
        "timotime.reports.export",
      ],
    });
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

  it("waliduje capabilities w Me oraz listy wpisów zespołu z pracownikiem", () => {
    const meParsed = Me.parse({
      account: { id: "acc-1", email: "jan@acme.test" },
      employee: { id: "emp-1", firstName: "Jan", lastName: "Nowak", fullName: "Jan Nowak", jobTitle: null },
      organization: { id: "org-1", name: "Acme" },
      capabilities: { trackOwnTime: true, viewTeam: true },
    });
    expect(meParsed.capabilities).toEqual({ trackOwnTime: true, viewTeam: true });

    const teamEntry = {
      id: "entry-1",
      organizationId: "org-1",
      accountId: "acc-2",
      employeeId: "emp-2",
      kind: "WORK",
      startedAt: "2026-11-24T08:00:00.000Z",
      endedAt: null,
      note: null,
      createdAt: "2026-11-24T08:00:00.000Z",
      updatedAt: "2026-11-24T08:00:00.000Z",
      employee: { id: "emp-2", firstName: "Anna", lastName: "Nowak" },
    };
    expect(TeamCurrentList.parse({ entries: [teamEntry] }).entries).toHaveLength(1);
    expect(
      TeamTimeEntriesList.parse({
        entries: [teamEntry],
        from: "2026-11-24T00:00:00.000Z",
        to: "2026-11-24T23:59:59.999Z",
      }).entries[0]?.employee.firstName,
    ).toBe("Anna");
  });
});
