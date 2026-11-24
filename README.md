# TimoTime

Ewidencja czasu pracy Monorise w przeglądarce i na telefonie: start i stop pracy, przerwy, praca zdalna i wyjścia służbowe. Logowanie tylko kontem Monorise przez MonoriseCore (`@monorise-team/auth`), baza PostgreSQL z Prismą i RLS (ADR-0095, ADR-0096).

| Część                                      | Co                                                                                           | Adres                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [`apps/web`](apps/web)                     | Next.js: strona produktu i API `/api/v1`, a pod drugim adresem aplikacja w przeglądarce      | `time.monorise.studio`, `timo-time.monorise.studio` |
| [`apps/mobile`](apps/mobile)               | Expo (iOS, Android)                                                                          | iOS, Android                                        |
| [`packages/contracts`](packages/contracts) | typy i schematy API, manifest uprawnień (`definePermissions`) i gotowe role produktu         |                                                     |
| [`packages/client`](packages/client)       | typowany klient API dla przeglądarki i telefonu oraz zarządzanie sesją aplikacji mobilnej    |                                                     |
| [`packages/db`](packages/db)               | baza `timo_time`: schemat Prisma, migracje z RLS, indeks jednego otwartego wpisu, `withUser` |                                                     |

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

PostgreSQL z Prismą (ADR-0096), lokalnie w Dockerze na porcie 5435. Serwer łączy się rolą `timo_time_app`, którą zawsze obowiązuje RLS: wpis czasu pracy widzi i zmienia tylko jego właściciel w swojej firmie (ADR-0037). Częściowy indeks unikalny na `ended_at IS NULL` gwarantuje w bazie najwyżej jeden otwarty wpis na osobę.

Zmiana schematu: edytuj `packages/db/prisma/schema.prisma`, wygeneruj migrację w `packages/db` (`pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`) do nowego katalogu w `packages/db/prisma/migrations/` i dodaj polityki RLS dla nowych tabel z danymi osób lub firm.

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

## Kontrole

```bash
pnpm check              # formatowanie, zgodność wersji, lint, typy, testy (w tym RLS i API), build (wymaga pnpm db:up)
pnpm test               # testy wszystkich paczek i aplikacji
```

## Wersje

Jedna wersja wszystkich części (ADR-0087): Release Please wylicza ją z commitów i aktualizuje `package.json` wszystkich aplikacji i paczek; Expo czyta ją z `apps/mobile/package.json`. `pnpm check:versions` odrzuca każdą rozbieżność.

Wspólne biblioteki `@monorise-team/*` mają w TimoTime zawsze jedną, dokładną wersję. Aktualizacja: Renovate (pull request co tydzień) albo ręcznie `pnpm shared:update` (`latest`, `dev` albo numer wersji).

Zasady pracy: [CONTRIBUTING.md organizacji](https://github.com/Monorise-Team/.github/blob/main/CONTRIBUTING.md).
