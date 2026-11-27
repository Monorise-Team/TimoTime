# Przypomnienia e-mail o czasie pracy (TimoTime#41)

Serwer TimoTime wysyła przypomnienia e-mail o czasie pracy przez moduł powiadomień MonoriseCore (`POST /core/v1/organizations/{organizationId}/notifications`, ADR-0048) w kategorii `timotime.reminders`.

## Jak działa zadanie w tle

- **Start:** `apps/web/src/instrumentation.ts` w środowisku `NEXT_RUNTIME === "nodejs"` wywołuje `startRemindersPolling()` z `apps/web/src/server/reminders.ts` (z zabezpieczeniem jednego cyklu na proces w `globalThis.__timotimeStopRemindersPolling` oraz pojedynczym wykonaniem w locie `single-flight`).
- **Interwał:** zmienna `TIMOTIME_REMINDERS_INTERVAL_MS` (w milisekundach, domyślnie `300000`, czyli co 5 minut; `0` albo niepoprawna wartość wyłącza zadanie).
- **Token maszynowy:** `timotime-web` (`apps/web/src/server/core-machine.ts`) prosi o zakresy `core:permissions.read core:directory.read core:events.read core:notifications.send`.
- **Wysyłka best-effort (`apps/web/src/server/notifications.ts`):** krótki limit czasu (`DEFAULT_NOTIFICATION_TIMEOUT_MS = 3000` ms), polityka ponawiania `@monorise-team/sdk` (dla `POST` z `Idempotency-Key`), ostrzeżenia w logach bez danych osobowych ani sekretów. MonoriseCore samo sprawdza aktywny dostęp odbiorcy oraz jego ustawienia powiadomień (`202 QUEUED` albo `202 SKIPPED`).

## Reguły przypomnień (`apps/web/src/server/reminders-rules.ts`)

Wszystkie daty i godziny wyliczane są w strefie czasowej firmy (`timeZone` z `GET /core/v1/products/timotime/directory/organization`) z poprawną obsługą zmian czasu DST (23- i 25-godzinne doby). Polskie dni ustawowo wolne od pracy (10 stałych: `1.01`, `6.01`, `1.05`, `3.05`, `15.08`, `1.11`, `11.11`, `24.12`, `25.12`, `26.12` oraz 4 ruchome od Wielkanocy: Niedziela i Poniedziałek Wielkanocny, Zielone Świątki +49 dni, Boże Ciało +60 dni) traktowane są jako dni wolne.

1. **Brak godzin (`missing-hours`):** od `09:00` czasu lokalnego w dzień pracy pracownika (`effectiveWorkSchedule[weekday] > 0`, nie święto i nie nieobecność), jeśli jego poprzedni dzień pracy (cofając się maksymalnie 14 dni, pomijając dni wolne i święta) nie ma żadnego wpisu rodzaju `WORK`. Brak grafiku → nigdy.
   - `Idempotency-Key`: `timotime-missing:{employeeId}:{YYYY-MM-DD}`
   - `actionUrl`: `{appOrigin}/?date={YYYY-MM-DD}#moj-czas`
2. **Zapomniany stoper (`forgotten-timer`):** otwarty wpis rodzaju `WORK` (`endedAt === null`) trwający dłużej niż `(minuty z grafiku dnia startu + 120 min)`; przy braku grafiku albo gdy dzień startu jest dniem wolnym/świętem próg wynosi `600 min`.
   - `Idempotency-Key`: `timotime-timer:{entryId}`
   - `actionUrl`: `{appOrigin}/?entry={entryId}#moj-czas`
3. **Podsumowanie tygodnia (`weekly-summary`):** od `15:00` czasu lokalnego w ostatni dzień pracy pracownika w bieżącym tygodniu ISO, jeśli suma czasu wpisów `WORK` w tygodniu (otwarte liczone do chwili `now`) jest niższa niż plan tygodnia pomniejszony o święta. Treść podaje brakujący czas zaokrąglony do 15 minut. Brak grafiku → nigdy.
   - `Idempotency-Key`: `timotime-week:{employeeId}:{isoYear}-W{isoWeek}`
   - `actionUrl`: `{appOrigin}/?view=week&week={isoYear}-W{isoWeek}#moj-czas`

Teksty wiadomości są po polsku, neutralne płciowo, bez form rodzajowych i bez półpauz. Link `actionUrl` wskazuje na origin `TIMOTIME_APP_URL` (zgodny z `uri` klienta OAuth `timotime-web`), a aplikacja przeglądarkowa (`apps/web/src/app/app/app-views.ts`, `MyTimeView.tsx`, `TimeTrackerApp.tsx`) otwiera odpowiednią zakładkę/baner i zachowuje parametry linku przy logowaniu.

## Wydajność, RLS i ograniczenia

- **Katalog Core:** jeden odczyt na firmę w oknie pamięci podręcznej (`DEFAULT_DIRECTORY_CACHE_TTL_MS = 4 min`): `getProductDirectoryOrganization` + stronicowane `listProductDirectoryEmployees`. Pomijani są pracownicy bez konta albo ze statusem innym niż `ACTIVE`.
- **Odczyt wpisów pod RLS:** `loadOrganizationTimeEntriesForReminders()` korzysta z `withTeamScope(db, { organizationId, accountId: REMINDERS_SYSTEM_ACCOUNT_ID }, { type: "ALL" }, ...)` (jedno zapytanie zakresowe na firmę po `organization_id`, `kind = WORK`, korzystające z istniejących indeksów; zapisy pozostają zablokowane przez `owner_isolation`).
- **Odkrywanie firm bez zmiany schematu bazy:** tabela `public.time_entries` ma `ENABLE` + `FORCE ROW LEVEL SECURITY` (nawet rola właściciela bez `BYPASSRLS` nie odczyta listy `organization_id` bez ustawionego `app.organization_id`), a Core API `0.0.1-dev.28` nie ma endpointu listy firm produktu. Bez zmiany schematu `discoverReminderOrganizationIds()` łączy unikalne `organization_id` z `auth.sessions` (bez RLS) z rejestrem firm aktywnych w procesie (`apps/web/src/server/reminder-orgs.ts`, uzupełnianym przez `startTimeEntry` i kanał zdarzeń). Oznacza to, że po restarcie serwera firma używająca wyłącznie aplikacji mobilnej (bez wiersza w `auth.sessions`) nie zostanie wykryta do czasu kolejnej aktywności albo dodania osobnej tabeli technicznej/endpointu Core.
- **Punkt rozszerzenia dla nieobecności (HiraHR):** interfejs `AbsenceProvider` w `apps/web/src/server/reminders.ts` (domyślnie `NOOP_ABSENCE_PROVIDER`) oraz predykat `EmployeeDayOffPredicate` w `apps/web/src/server/reminders-rules.ts` pozwalają bez zmian w regułach podpiąć urlopy i zwolnienia z HiraHR.

## Testy

- `apps/web/test/reminders-rules.test.ts` (bez bazy): polskie święta (w tym 2026: Wielkanoc 5.04, Boże Ciało 4.06), poprzedni dzień pracy, progi stopera, sumy tygodnia ISO, zaokrąglanie do 15 min, klucze idempotencji, teksty PL i przejścia DST (ostatnia niedziela marca i października).
- `apps/web/test/reminders.test.ts` (bez bazy): wysyłka przez Core SDK, ponawianie 503, obsługa 500/timeout bez danych osobowych w logach, scenariusze zadania z atrapą Core (`apps/web/test/helpers/fake-core-reminders.ts`), cache katalogu, idempotencja, `AbsenceProvider` i konfiguracja `TIMOTIME_REMINDERS_INTERVAL_MS`.
- `apps/web/test/reminders-db.test.ts` (wymaga PostgreSQL): scenariusze zadania z prawdziwymi wpisami w bazie (`withUser` + `withTeamScope`), wykrywanie firm z `auth.sessions` i izolacja między firmami przez RLS.
