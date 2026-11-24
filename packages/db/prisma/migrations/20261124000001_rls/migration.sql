-- Separacja firm i osób (ADR-0037): uprawnienia roli aplikacji i RLS.
-- ── Uprawnienia roli aplikacji ─────────────────────────────────────────────────────────────────────
-- timo_time_app pracuje na danych, ale nie jest właścicielem tabel i nie omija RLS.
GRANT USAGE ON SCHEMA "public", "auth" TO timo_time_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public", "auth" TO timo_time_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA "public", "auth" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO timo_time_app;
-- Historia migracji Prismy nie jest dla aplikacji (tabela powstaje przed tą migracją przy prisma migrate).
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON "public"."_prisma_migrations" FROM timo_time_app;
  END IF;
END $$;

-- ── Osoba i firma ze zmiennych transakcji ustawianych przez serwer (withUser w @timotime/db) ─────────
--   SELECT set_config('app.organization_id', '<uuid>', true), set_config('app.account_id', '<uuid>', true)
-- Bez nich polityki nie zwracają żadnego wiersza i nie pozwalają nic zapisać.
CREATE FUNCTION "public"."current_organization_id"() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid $$;

CREATE FUNCTION "public"."current_account_id"() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.account_id', true), '')::uuid $$;

-- ── Wpisy czasu pracy: w pierwszej wersji widzi i zmienia je tylko ich właściciel w swojej firmie ────
-- Anna z Acme widzi tylko swoje wpisy; inna osoba z Acme ani nikt z innej firmy ich nie zobaczy ani nie zmieni.
ALTER TABLE "public"."time_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."time_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON "public"."time_entries"
  USING (
    "organization_id" = "public"."current_organization_id"()
    AND "account_id" = "public"."current_account_id"()
  )
  WITH CHECK (
    "organization_id" = "public"."current_organization_id"()
    AND "account_id" = "public"."current_account_id"()
  );

-- Sesje przeglądarki (auth.sessions) są bez RLS: serwer szuka ich po skrócie identyfikatora z ciasteczka,
-- zanim wie, czyja to sesja. Tokeny w sesji są zaszyfrowane kluczem aplikacji (@monorise-team/auth).
