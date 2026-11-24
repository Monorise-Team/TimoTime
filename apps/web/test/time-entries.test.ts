import { Prisma } from "@timotime/db";
import { describe, expect, it } from "vitest";
import { isOpenEntryConflict } from "@/server/time-entries";

describe("rozpoznawanie konfliktu równoczesnego startu", () => {
  it("rozpoznaje Prisma P2002 dla indeksu time_entries_one_open_per_account_idx", () => {
    const error = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "7.10.1",
      meta: {
        driverAdapterError: {
          cause: {
            originalCode: "23505",
            constraint: { index: "time_entries_one_open_per_account_idx" },
          },
        },
      },
    });
    expect(isOpenEntryConflict(error)).toBe(true);
  });

  it("rozpoznaje surowy błąd PostgreSQL SQLSTATE 23505", () => {
    const direct = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      constraint: "time_entries_one_open_per_account_idx",
    });
    expect(isOpenEntryConflict(direct)).toBe(true);

    const wrapped = new Error("wrapper", { cause: direct });
    expect(isOpenEntryConflict(wrapped)).toBe(true);
  });

  it("ignoruje inne błędy bazy", () => {
    const notFound = new Prisma.PrismaClientKnownRequestError("Record not found", {
      code: "P2025",
      clientVersion: "7.10.1",
    });
    expect(isOpenEntryConflict(notFound)).toBe(false);
    expect(isOpenEntryConflict(new Error("connection reset"))).toBe(false);
  });
});
