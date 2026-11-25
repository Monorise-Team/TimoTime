# TimoTime

Ewidencja czasu pracy Monorise w przeglądarce i na telefonie: start i stop pracy, przerwy, praca zdalna i wyjścia służbowe. Logowanie tylko kontem Monorise przez MonoriseCore (`@monorise-team/auth`), baza PostgreSQL z Prismą i RLS (ADR-0095, ADR-0096).

| Część                                      | Co                                                                                                             | Adres                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [`apps/web`](apps/web)                     | Next.js: strona produktu i API `/api/v1`, a pod drugim adresem aplikacja w przeglądarce                        | `time.monorise.studio`, `timo-time.monorise.studio` |
| [`apps/mobile`](apps/mobile)               | Expo (iOS, Android)                                                                                            | iOS, Android                                        |
| [`packages/contracts`](packages/contracts) | typy i schematy API, manifest uprawnień (`definePermissions`) i gotowe role produktu                           |                                                     |
| [`packages/client`](packages/client)       | typowany klient API dla przeglądarki i telefonu oraz zarządzanie sesją aplikacji mobilnej                      |                                                     |
| [`packages/db`](packages/db)               | baza `timo_time`: schemat Prisma, migracje z RLS, indeks jednego otwartego wpisu, `withUser` i `withTeamScope` |                                                     |

## Uruchomienie lokalne

Potrzebne: Node.js 24 (`.nvmrc`), pnpm 11, Docker (lokalna baza PostgreSQL) oraz działający lokalnie [MonoriseCore](https://github.com/Monorise-Team/MonoriseCore) (logowanie na `localhost:3100` i Core API na `localhost:3200`).

```bash
# raz: dostęp do paczek @monorise-team/* w GitHub Packages
gh auth refresh -h github.com -s read:packages
export GITHUB_PACKAGES_TOKEN=$(gh auth token)

# raz, w MonoriseCore: klienci OAuth timotime-web i timotime-mobile oraz sekrety (apps/auth/.data/oauth-clients.json)
pnpm oauth:seed

pnpm install
pnpm setup:env          # apps/web/.env.local i packages/db/.env; sekret timotime-web bierze z MonoriseCore
pnpm db:up              # PostgreSQL w Dockerze (kontener timo-time-postgres-1, port 5435)
pnpm db:migrate         # migracje bazy timo_time i bazy testów timo_time_test
pnpm dev                # http://time.localhost:3300 (strona i API) i http://timo-time.localhost:3300 (aplikacja)
```

Jeśli repozytorium albo git worktree nie leży obok katalogu `MonoriseCore`, wskaż plik z sekretami OAuth Core przez zmienną `CORE_OAUTH_SECRETS_FILE`, na przykład:

```bash
CORE_OAUTH_SECRETS_FILE=/sciezka/do/MonoriseCore/apps/auth/.data/oauth-clients.json pnpm setup:env
```

Logowanie: TimoTime korzysta z kont Monorise, więc obok musi działać MonoriseCore (`pnpm dev` w MonoriseCore: logowanie na `localhost:3100`, Core API na `localhost:3200`). Przycisk „Zaloguj się kontem Monorise” przekierowuje na ekran logowania Core i wraca do aplikacji z sesją BFF w ciasteczku `HttpOnly`.

### Aplikacja na telefon

```bash
pnpm dev:mobile         # Expo; adresy: EXPO_PUBLIC_TIMOTIME_API (domyślnie http://127.0.0.1:3300) i EXPO_PUBLIC_CORE_API_URL (http://localhost:3200)
```

Logowanie na telefonie: przycisk „Zaloguj się kontem Monorise” otwiera ekran logowania Core w przeglądarce systemowej (PKCE, klient `timotime-mobile`) z prośbą o dostęp do obu zasobów (API TimoTime i Core API). Powrót działa przez `timotime://oauth/callback` (w Expo Go przez `exp://127.0.0.1:8081/--/oauth/callback`, dlatego Metro startuje z `--localhost`). Tokeny trafiają do systemowego sejfu (`expo-secure-store`), a dane osoby i firmy aplikacja pobiera bezpośrednio z Core API przez `@monorise-team/sdk` osobnym tokenem Core API.

### Baza danych

PostgreSQL z Prismą (ADR-0096), lokalnie w Dockerze na porcie 5435. Serwer łączy się rolą `timo_time_app`, którą zawsze obowiązuje RLS: własne wpisy czasu pracy widzi i zmienia tylko ich właściciel w swojej firmie (`withUser`, polityka `owner_isolation`, ADR-0037), a widok kierownika rozszerza wyłącznie odczyt (`SELECT`) do pracowników w zakresie uprawnień kierownika tej samej firmy (`withTeamScope`, polityka `team_read_isolation`). Zapisy pozostają wyłącznie dla właściciela. Częściowy indeks unikalny na `ended_at IS NULL` gwarantuje w bazie najwyżej jeden otwarty wpis na osobę.

Zmiana schematu: edytuj `packages/db/prisma/schema.prisma`, wygeneruj migrację w `packages/db` (`pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`) do nowego katalogu w `packages/db/prisma/migrations/` i dodaj polityki RLS dla nowych tabel z danymi osób lub firm.

## Uprawnienia z MonoriseCore i widok kierownika

### Jak serwer TimoTime sprawdza uprawnienia

Serwer TimoTime pobiera w MonoriseCore token maszynowy OAuth 2.1 (`grant_type=client_credentials`, poufny klient `timotime-web`, zakresy `core:permissions.read core:directory.read`, pamięć podręczna do 30 sekund przed wygaśnięciem) i przez `@monorise-team/sdk` odczytuje migawkę uprawnień (`GET /core/v1/products/timotime/permission-snapshot`). Identyfikatory firmy (`org_id`), konta (`sub`) oraz wersja uprawnień (`authz_rev`) pochodzą wyłącznie ze zweryfikowanego tokenu lub sesji użytkownika.

Migawki trzyma jedna pamięć podręczna `createPermissionCache` z `@monorise-team/permissions` (maksymalnie 5 minut, odświeżana od razu po wzroście `authz_rev` w tokenie). Sprawdzanie uprawnień odbywa się w jednym miejscu (`apps/web/src/server/permissions.ts`):

- brak `"timotime"` w `snapshot.products` kończy się błędem `403 PRODUCT_ACCESS_REQUIRED` z czytelnym komunikatem dla użytkownika (brak konkretnego uprawnienia nadal zwraca `403 PERMISSION_DENIED`),
- własne wpisy wymagają `timotime.entries.read_own` (odczyt) oraz `timotime.entries.write_own` (start i stop),
- `GET /api/v1/me` (przeglądarka BFF) zwraca dodatkowo `capabilities: { trackOwnTime, viewTeam }`, na podstawie których interfejs pokazuje albo ukrywa zakładkę „Zespół”.

### Odświeżanie uprawnień po zdarzeniach z Core

Gdy w MonoriseCore zmienią się uprawnienia lub dostęp osoby, Core zapisuje numerowane zdarzenie `organization.permissions.changed` w kanale HTTP produktu (`GET /core/v1/products/timotime/events`). Serwer TimoTime pobiera te zdarzenia przez `@monorise-team/sdk` (token maszynowy z zakresem `core:events.read`) i przetwarza je przez `@monorise-team/events`:

- po odebraniu `organization.permissions.changed` natychmiast czyści pamięć podręczną uprawnień dla wskazanej firmy i konta,
- interwał odpytywania ustawia zmienna `TIMOTIME_EVENT_FEED_INTERVAL_MS` w milisekundach (domyślnie `5000` przy `NODE_ENV=development`, w pozostałych środowiskach `0`, czyli wyłączone; `0` albo niepoprawna wartość również wyłącza odpytywanie),
- przy starcie serwera Node.js odpytywanie uruchamia `apps/web/src/instrumentation.ts`,
- stan kanału trzymają dwie tabele w schemacie `public` bez RLS (nie zawierają danych osób ani firm): `event_feed_cursors` (ostatni przetworzony numer `sequence` dla kanału `core`) oraz `processed_events` (deduplikacja przetworzonych zdarzeń).
- ograniczenie: pamięć uprawnień jest w pamięci procesu, a kursor i przetworzone zdarzenia są wspólne w bazie, więc przy kilku instancjach serwera zdarzenie wyczyści pamięć tylko w tej, która je pobrała (pozostałe odświeżą migawkę najpóźniej po 5 minutach albo od razu przy wyższym `authz_rev` w tokenie). Dziś TimoTime działa jako jeden proces; przed skalowaniem potrzebna jest wspólna pamięć podręczna albo kursor na instancję.

### Czego potrzebuje osoba, aby korzystać z TimoTime

1. **Dostęp firmy do produktu (`Entitlement`)**: firma musi mieć aktywny dostęp do produktu `timotime` w MonoriseCore.
2. **Włączony dostęp do aplikacji (`AppAccess`)**: Owner firmy ma dostęp automatycznie, gdy firma ma `Entitlement`. Pozostałym pracownikom Owner (albo osoba z `core.app_access.manage`) włącza aplikację `timotime`.
3. **Rola w TimoTime**: zwykły pracownik potrzebuje gotowej roli „Pracownik” (`timotime.employee`, uprawnienia `entries.read_own` i `entries.write_own`), a kierownik roli „Kierownik” (`timotime.manager`, z `timotime.entries.read`) nadanej w zakresie jednostki (`UNIT`) albo całej firmy (`ORGANIZATION`). Owner ma wszystkie uprawnienia produktu po włączeniu `Entitlement`.

### Konfiguracja lokalna w MonoriseCore

Po uruchomieniu MonoriseCore (`pnpm oauth:seed` i `pnpm dev` w MonoriseCore) oraz rejestracji uprawnień i szablonów ról TimoTime (`pnpm permissions:register` w TimoTime):

```bash
# 1. W MonoriseCore: przyznaj firmie dostęp do produktu timotime
pnpm entitlement:grant -- --organization acme.test --product timotime
```

Następnie w Core API (`http://localhost:3200/core/v1`, z tokenem Ownera firmy):

- włącz aplikację pracownikowi: `POST /core/v1/app-access` z `{ "accountId": "<uuid>", "product": "timotime" }`,
- sprawdź identyfikatory gotowych ról TimoTime: `GET /core/v1/roles?product=timotime`,
- nadaj rolę „Pracownik” albo „Kierownik” w wybranym zakresie (`ORGANIZATION` albo `UNIT`): `POST /core/v1/role-assignments`.

### Widok kierownika (Zespół)

Osoby z uprawnieniem `timotime.entries.read` (np. Kierownik oddziału albo Owner) widzą w przeglądarce zakładkę „Zespół” obok rejestracji własnego czasu pracy. Trasy `GET /api/v1/team/current` (kto teraz pracuje) oraz `GET /api/v1/team/entries?from&to` (wpisy z przedziału do 31 dni, w tym nocne) wyliczają zakres przez `scopeOf(snapshot, "timotime.entries.read")`:

- `ORGANIZATION`: wszyscy pracownicy firmy,
- `LIMITED`: pracownicy z rozwiniętego poddrzewa jednostek `scope.unitIds` pobierani z Core Directory (`listProductDirectoryUnitMembers` ze stronicowaniem `paginate`); nadania zakresu `RESOURCE` są na tym etapie pomijane,
- `NONE`: odmowa `403 PERMISSION_DENIED`.

Imiona i nazwiska potrzebnych pracowników serwer dociąga z Core Directory (`listProductDirectoryEmployees`, w paczkach po 100 identyfikatorów). Widok zespołu nie obejmuje jeszcze aplikacji mobilnej.

## Rejestracja uprawnień w MonoriseCore

TimoTime deklaruje w kodzie (`packages/contracts/src/permissions.ts`) swój manifest uprawnień (`TIMOTIME_PERMISSION_MANIFEST`) oraz gotowe role produktu (`TIMOTIME_ROLE_TEMPLATES`: Pracownik i Kierownik). Polecenie rejestracji pobiera w MonoriseCore token maszynowy OAuth 2.1 (`grant_type=client_credentials`, zakres `core:permissions.register`), po czym wysyła najpierw manifest na `PUT /core/v1/products/timotime/permissions`, a następnie szablony ról na `PUT /core/v1/products/timotime/role-templates`. Operacja jest idempotentna: ponowne uruchomienie bez zmian niczego nie modyfikuje.

Kiedy uruchamiać: lokalnie po `pnpm oauth:seed` i uruchomieniu MonoriseCore oraz po zmianie uprawnień albo gotowych ról w TimoTime. Po uruchomieniu wdrożeń TimoTime i Core (ADR-0097) to samo polecenie będzie wywoływał krok workflow przy wdrożeniu.

```bash
pnpm permissions:register
```

Wymagane zmienne środowiskowe (lokalnie z fallbackiem do `apps/web/.env.local`, który tworzy `pnpm setup:env`):

- `CORE_AUTH_URL`: adres serwera logowania MonoriseCore (np. `http://localhost:3100`),
- `CORE_API_URL`: adres Core API i odbiorca tokenu maszynowego (np. `http://localhost:3200`),
- `TIMOTIME_OAUTH_CLIENT_ID`: identyfikator poufnego klienta produktu (`timotime-web`),
- `TIMOTIME_OAUTH_CLIENT_SECRET`: sekret tego klienta (lokalnie z `pnpm oauth:seed` w MonoriseCore).

## Zgodność z kontraktem produktu

TimoTime jest sprawdzane wspólną biblioteką `@monorise-team/testing` (ADR-0046, ADR-0075) z atrapą MonoriseCore (`createFakeCore`) i opisem OpenAPI 3.1 generowanym z kodu (`apps/web/src/server/routes.ts`, `apps/web/src/server/openapi.ts`, schematy Zod z `@timotime/contracts`):

- **Obowiązek 1 (uwierzytelnienie i uprawnienia)**: `apps/web/test/contract.test.ts` (`defineProductContractTests`) sprawdza, że każda chroniona trasa `/api/v1/*` odrzuca brak tokenu oraz niepoprawne tokeny (`401 UNAUTHENTICATED`), a poprawny token bez uprawnienia kończy się `403 PERMISSION_DENIED` w kopercie błędu `{ data: null, meta: { requestId }, error }`.
- **Obowiązek 6 (dostęp firmy i konta do produktu)**: brak `Entitlement` firmy lub wyłączony `AppAccess` konta zwraca `403 PRODUCT_ACCESS_REQUIRED` na wszystkich trasach chronionych dostępem do produktu; trasa BFF `GET /api/v1/me` pozostaje dostępna, aby interfejs pokazał stan braku dostępu.
- **Obowiązek 7 (OpenAPI 3.1)**: plik [`openapi/timotime-api.json`](openapi/timotime-api.json) opisuje wszystkie trasy `/api/v1/*`, oba schematy uwierzytelnienia (`bearerAuth` i `sessionCookie`), wspólny schemat błędu `ApiErrorResponse` oraz zapytania zakresowe `entries` (`from`, `to`, do 31 dni, bez stronicowania kursorowego).
- **Separacja firm (RLS, ADR-0037)**: `apps/web/test/tenant-isolation.test.ts` (`checkTenantIsolation`) weryfikuje na testowej bazie PostgreSQL, że firma B nigdy nie odczyta wpisów firmy A przez `withUser` ani `withTeamScope`.

```bash
pnpm openapi                                                         # generuje openapi/timotime-api.json z kodu
pnpm openapi:check                                                   # sprawdza aktualność openapi/timotime-api.json
pnpm --filter @timotime/web exec vitest run test/contract.test.ts    # testy kontraktu produktu (bez bazy)
```

## Kontrole

```bash
pnpm check              # formatowanie, zgodność wersji, OpenAPI, lint, typy, testy (kontrakt, RLS i API), build (wymaga pnpm db:up)
pnpm openapi:check      # sprawdzenie aktualności openapi/timotime-api.json
pnpm test               # testy wszystkich paczek i aplikacji
```

## Wersje

Jedna wersja wszystkich części (ADR-0087): Release Please wylicza ją z commitów i aktualizuje `package.json` wszystkich aplikacji i paczek; Expo czyta ją z `apps/mobile/package.json`. `pnpm check:versions` odrzuca każdą rozbieżność.

Wspólne biblioteki `@monorise-team/*` mają w TimoTime zawsze jedną, dokładną wersję. Aktualizacja: Renovate (pull request co tydzień) albo ręcznie `pnpm shared:update` (`latest`, `dev` albo numer wersji).

Zasady pracy: [CONTRIBUTING.md organizacji](https://github.com/Monorise-Team/.github/blob/main/CONTRIBUTING.md).
