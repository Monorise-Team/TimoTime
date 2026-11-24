-- Odczyt wpisów czasu pracy zespołu w zakresie uprawnień kierownika (ADR-0037, TimoTime#7).
-- Polityka dotyczy wyłącznie SELECT; zapisy (INSERT, UPDATE, DELETE) nadal podlegają wyłącznie
-- polityce owner_isolation (tylko własne wpisy właściciela w swojej firmie).
--
-- Serwer ustawia lokalne zmienne transakcji przez withTeamScope w @timotime/db:
--   - app.organization_id (UUID firmy z tokenu albo sesji)
--   - app.account_id (UUID konta z tokenu albo sesji)
--   - app.team_scope = 'ALL' (zakres ORGANIZATION) albo
--   - app.team_employee_ids = '<uuid>,<uuid>,...' (zakres LIMITED, lista z Core Directory)
-- Bez ustawienia tych zmiennych polityka zwraca FALSE i nie rozszerza widoczności.

CREATE FUNCTION "public"."current_team_scope"() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.team_scope', true), '') $$;

CREATE FUNCTION "public"."current_team_employee_ids"() RETURNS uuid[]
  LANGUAGE sql STABLE
  AS $$
    SELECT CASE
      WHEN NULLIF(current_setting('app.team_employee_ids', true), '') IS NULL THEN ARRAY[]::uuid[]
      ELSE string_to_array(current_setting('app.team_employee_ids', true), ',')::uuid[]
    END
  $$;

CREATE POLICY team_read_isolation ON "public"."time_entries"
  FOR SELECT
  USING (
    "organization_id" = "public"."current_organization_id"()
    AND (
      "public"."current_team_scope"() = 'ALL'
      OR "employee_id" = ANY("public"."current_team_employee_ids"())
    )
  );

-- Indeks pod zapytania widoku zespołu (bieżący status i wpisy pracowników w zakresie dat).
CREATE INDEX "time_entries_organization_id_employee_id_started_at_idx"
  ON "public"."time_entries"("organization_id", "employee_id", "started_at");
