import "server-only";
import type { SessionStore } from "@monorise-team/auth/next";
import { getDb } from "./db";

/**
 * Sesje przeglądarki w tabeli auth.sessions. Bez RLS: serwer szuka ich po skrócie identyfikatora z ciasteczka,
 * zanim wie, czyja to sesja. Tokeny z Core są w `data` zaszyfrowane kluczem z TIMOTIME_SESSION_SECRET.
 */
export const sessionStore: SessionStore = {
  async get(id) {
    const row = await getDb().session.findUnique({ where: { id } });
    return row
      ? {
          id: row.id,
          accountId: row.accountId,
          organizationId: row.organizationId,
          expiresAt: row.expiresAt,
          data: row.data,
        }
      : null;
  },
  async set(record) {
    const values = {
      accountId: record.accountId,
      organizationId: record.organizationId,
      expiresAt: record.expiresAt,
      data: record.data,
    };
    await getDb().session.upsert({ where: { id: record.id }, create: { id: record.id, ...values }, update: values });
  },
  async delete(id) {
    await getDb().session.deleteMany({ where: { id } });
  },
};
