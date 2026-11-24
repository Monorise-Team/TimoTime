import { afterAll, describe, expect, it } from "vitest";
import { createDb, uuidv7, withUser, type Actor } from "../src/index.js";

// Rola aplikacji (timo_time_app): RLS obowiązuje ją zawsze. Lokalnie: pnpm db:up && pnpm db:migrate.
const url =
  process.env.TIMOTIME_TEST_APP_DATABASE_URL ??
  "postgresql://timo_time_app:timo_time_app@localhost:5435/timo_time_test";
const db = createDb(url);

const acme = uuidv7();
const globex = uuidv7();
const anna: Actor = { organizationId: acme, accountId: uuidv7() };
const bartek: Actor = { organizationId: acme, accountId: uuidv7() };
const celina: Actor = { organizationId: globex, accountId: uuidv7() };

const entry = (actor: Actor, overrides: { endedAt?: Date | null; note?: string | null } = {}) => ({
  id: uuidv7(),
  organizationId: actor.organizationId,
  accountId: actor.accountId,
  employeeId: uuidv7(),
  kind: "WORK" as const,
  startedAt: new Date("2026-11-24T08:00:00.000Z"),
  endedAt: overrides.endedAt === undefined ? new Date("2026-11-24T12:00:00.000Z") : overrides.endedAt,
  note: overrides.note ?? null,
});

afterAll(async () => {
  for (const actor of [anna, bartek, celina]) {
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
