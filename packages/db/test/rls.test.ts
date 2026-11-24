import { afterAll, describe, expect, it } from "vitest";
import { createDb, uuidv7, withTeamScope, withUser, type Actor } from "../src/index.js";

// Rola aplikacji (timo_time_app): RLS obowiązuje ją zawsze. Lokalnie: pnpm db:up && pnpm db:migrate.
const url =
  process.env.TIMOTIME_TEST_APP_DATABASE_URL ??
  "postgresql://timo_time_app:timo_time_app@localhost:5435/timo_time_test";
const db = createDb(url);

const acme = uuidv7();
const globex = uuidv7();
const anna: Actor = { organizationId: acme, accountId: uuidv7() };
const bartek: Actor = { organizationId: acme, accountId: uuidv7() };
const jan: Actor = { organizationId: acme, accountId: uuidv7() };
const piotr: Actor = { organizationId: acme, accountId: uuidv7() };
const celina: Actor = { organizationId: globex, accountId: uuidv7() };

const annaEmployeeId = uuidv7();
const piotrEmployeeId = uuidv7();
const janEmployeeId = uuidv7();
const celinaEmployeeId = uuidv7();

const entry = (actor: Actor, overrides: { employeeId?: string; endedAt?: Date | null; note?: string | null } = {}) => ({
  id: uuidv7(),
  organizationId: actor.organizationId,
  accountId: actor.accountId,
  employeeId: overrides.employeeId ?? uuidv7(),
  kind: "WORK" as const,
  startedAt: new Date("2026-11-24T08:00:00.000Z"),
  endedAt: overrides.endedAt === undefined ? new Date("2026-11-24T12:00:00.000Z") : overrides.endedAt,
  note: overrides.note ?? null,
});

afterAll(async () => {
  for (const actor of [anna, bartek, jan, piotr, celina]) {
    await withUser(db, actor, (tx) => tx.timeEntry.deleteMany({}));
  }
  await db.session.deleteMany({ where: { organizationId: { in: [acme, globex] } } });
  await db.$disconnect();
});

describe("RLS: wpisy czasu pracy widzi i zmienia tylko ich właściciel w swojej firmie", () => {
  it("Anna widzi swój wpis, Bartek z tej samej firmy i Celina z innej nie", async () => {
    const own = await withUser(db, anna, (tx) => tx.timeEntry.create({ data: entry(anna) }));
    expect(await withUser(db, anna, (tx) => tx.timeEntry.count())).toBe(1);
    expect(await withUser(db, bartek, (tx) => tx.timeEntry.findUnique({ where: { id: own.id } }))).toBeNull();
    expect(await withUser(db, celina, (tx) => tx.timeEntry.count())).toBe(0);
    // Bez ustawionej osoby i firmy baza nie zwraca nic
    expect(await db.timeEntry.count()).toBe(0);
  });

  it("nie da się zapisać wpisu w cudzym imieniu ani zmienić cudzego", async () => {
    await expect(withUser(db, anna, (tx) => tx.timeEntry.create({ data: entry(bartek) }))).rejects.toThrow();
    await expect(withUser(db, anna, (tx) => tx.timeEntry.create({ data: entry(celina) }))).rejects.toThrow();

    const bartekEntry = await withUser(db, bartek, (tx) => tx.timeEntry.create({ data: entry(bartek) }));
    const changed = await withUser(db, anna, (tx) =>
      tx.timeEntry.updateMany({ where: { id: bartekEntry.id }, data: { note: "zmienione" } }),
    );
    expect(changed.count).toBe(0);
    const removed = await withUser(db, celina, (tx) => tx.timeEntry.deleteMany({ where: { id: bartekEntry.id } }));
    expect(removed.count).toBe(0);
  });

  it("indeks częściowy blokuje dwa otwarte wpisy tej samej osoby", async () => {
    await withUser(db, celina, (tx) => tx.timeEntry.create({ data: entry(celina, { endedAt: null }) }));
    await expect(
      withUser(db, celina, (tx) => tx.timeEntry.create({ data: entry(celina, { endedAt: null }) })),
    ).rejects.toThrow();
  });

  it("sesje przeglądarki są dostępne po identyfikatorze bez ustawionej firmy", async () => {
    const id = `skrot-${uuidv7()}`;
    await db.session.create({
      data: {
        id,
        accountId: anna.accountId,
        organizationId: acme,
        expiresAt: new Date(Date.now() + 60_000),
        data: "x",
      },
    });
    expect((await db.session.findUnique({ where: { id } }))?.accountId).toBe(anna.accountId);
    await db.session.delete({ where: { id } });
  });

  it("rola aplikacji nie widzi historii migracji", async () => {
    await expect(db.$queryRaw`SELECT count(*) FROM public._prisma_migrations`).rejects.toThrow(/permission denied/);
  });
});

describe("RLS: odczyt wpisów zespołu przez withTeamScope", () => {
  it("zakres EMPLOYEES widzi tylko wskazanych pracowników tej samej firmy, nigdy innej firmy", async () => {
    const annaRow = await withUser(db, anna, (tx) =>
      tx.timeEntry.create({ data: entry(anna, { employeeId: annaEmployeeId }) }),
    );
    const piotrRow = await withUser(db, piotr, (tx) =>
      tx.timeEntry.create({ data: entry(piotr, { employeeId: piotrEmployeeId }) }),
    );
    const celinaRow = await withUser(db, celina, (tx) =>
      tx.timeEntry.create({ data: entry(celina, { employeeId: celinaEmployeeId }) }),
    );

    // Bez withTeamScope Jan nie widzi żadnych cudzych wpisów
    expect(await withUser(db, jan, (tx) => tx.timeEntry.findMany())).toEqual([]);

    // Nawet podanie employeeId Celiny z innej firmy nie ujawnia jej wpisu (separacja organization_id)
    const visible = await withTeamScope(
      db,
      jan,
      { type: "EMPLOYEES", employeeIds: [annaEmployeeId, celinaEmployeeId] },
      (tx) => tx.timeEntry.findMany({ orderBy: { id: "asc" } }),
    );
    const visibleIds = visible.map((row) => row.id);
    expect(visibleIds).toContain(annaRow.id);
    expect(visibleIds).not.toContain(piotrRow.id);
    expect(visibleIds).not.toContain(celinaRow.id);

    // Pusta lista employeeIds nie rozszerza widoczności
    const emptyScope = await withTeamScope(db, jan, { type: "EMPLOYEES", employeeIds: [] }, (tx) =>
      tx.timeEntry.findMany(),
    );
    expect(emptyScope).toEqual([]);

    // Po zakończeniu transakcji withTeamScope zmienne znikają i nie przeciekają na kolejne zapytania
    expect(await withUser(db, jan, (tx) => tx.timeEntry.findMany())).toEqual([]);
    expect(await db.timeEntry.count()).toBe(0);
  });

  it("zakres ALL widzi wszystkich pracowników firmy i nigdy innej firmy", async () => {
    const allAcme = await withTeamScope(db, jan, { type: "ALL" }, (tx) => tx.timeEntry.findMany());
    const orgIds = new Set(allAcme.map((row) => row.organizationId));
    expect(orgIds).toEqual(new Set([acme]));
    expect(allAcme.some((row) => row.employeeId === annaEmployeeId)).toBe(true);
    expect(allAcme.some((row) => row.employeeId === piotrEmployeeId)).toBe(true);
    expect(allAcme.some((row) => row.employeeId === celinaEmployeeId)).toBe(false);
  });

  it("zapisy w withTeamScope nadal dotyczą wyłącznie własnych wpisów właściciela", async () => {
    const annaRows = await withUser(db, anna, (tx) => tx.timeEntry.findMany({ where: { employeeId: annaEmployeeId } }));
    const annaEntry = annaRows[0]!;

    // Nie da się utworzyć wpisu w imieniu Anny ani zmodyfikować czy usunąć jej wpisu
    await expect(
      withTeamScope(db, jan, { type: "ALL" }, (tx) =>
        tx.timeEntry.create({ data: entry(anna, { employeeId: annaEmployeeId }) }),
      ),
    ).rejects.toThrow();

    const updated = await withTeamScope(db, jan, { type: "ALL" }, (tx) =>
      tx.timeEntry.updateMany({ where: { id: annaEntry.id }, data: { note: "zmiana kierownika" } }),
    );
    expect(updated.count).toBe(0);

    const deleted = await withTeamScope(db, jan, { type: "ALL" }, (tx) =>
      tx.timeEntry.deleteMany({ where: { id: annaEntry.id } }),
    );
    expect(deleted.count).toBe(0);

    // Własny wpis Jana nadal przechodzi INSERT ... RETURNING, UPDATE i DELETE
    const own = await withTeamScope(db, jan, { type: "ALL" }, (tx) =>
      tx.timeEntry.create({ data: entry(jan, { employeeId: janEmployeeId }) }),
    );
    expect(own.accountId).toBe(jan.accountId);
    const ownUpdated = await withTeamScope(db, jan, { type: "ALL" }, (tx) =>
      tx.timeEntry.update({ where: { id: own.id }, data: { note: "własna notatka" } }),
    );
    expect(ownUpdated.note).toBe("własna notatka");
    const ownDeleted = await withTeamScope(db, jan, { type: "ALL" }, (tx) =>
      tx.timeEntry.deleteMany({ where: { id: own.id } }),
    );
    expect(ownDeleted.count).toBe(1);
  });

  it("odrzuca niepoprawny UUID przed wysłaniem zapytania do bazy", async () => {
    await expect(
      withTeamScope(db, jan, { type: "EMPLOYEES", employeeIds: ["nie-uuid"] }, (tx) => tx.timeEntry.findMany()),
    ).rejects.toThrow(/UUID/);
  });
});
