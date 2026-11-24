# TimoTime

Ewidencja czasu pracy Monorise w przeglądarce i na telefonie: start i stop pracy, przerwy, praca zdalna i wyjścia służbowe. Logowanie tylko kontem Monorise przez MonoriseCore (`@monorise-team/auth`), baza PostgreSQL z Prismą i RLS (ADR-0095, ADR-0096).

| Część                                      | Co                                                                                         | Adres                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| [`apps/web`](apps/web)                     | Next.js: strona produktu i API `/api/v1`, a pod drugim adresem aplikacja w przeglądarce    | `time.monorise.studio`, `timo-time.monorise.studio`  |
| [`apps/mobile`](apps/mobile)               | Expo (iOS, Android)                                                                        | iOS, Android                                         |
| [`packages/contracts`](packages/contracts) | typy i schematy API oraz manifest uprawnień (`definePermissions`)                          |                                                      |
| [`packages/client`](packages/client)       | typowany klient API dla przeglądarki i telefonu oraz zarządzanie sesją aplikacji mobilnej  |                                                      |
| [`packages/db`](packages/db)               | baza `timo_time`: schemat Prisma, migracje z RLS, indeks jednego otwartego wpisu, `withUser` |                                                    |

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

Logowanie: TimoTime korzysta z kont Monorise, więc obok musi działać MonoriseCore (`pnpm dev` w MonoriseCore: logowanie na `localhost:3100`, Core API na `localhost:3200`). Przycisk „Zaloguj się kontem Monorise” przekierowuje na ekran logowania Core i wraca do aplikacji z sesją BFF w ciasteczku `HttpOnly`.

### Aplikacja na telefon

```bash
pnpm dev:mobile         # Expo; adres serwera: EXPO_PUBLIC_TIMOTIME_API (symulator iOS: http://127.0.0.1:3300)
```

Logowanie na telefonie: przycisk „Zaloguj się kontem Monorise” otwiera ekran logowania Core w przeglądarce systemowej (PKCE, klient `timotime-mobile`). Powrót działa przez `timotime://oauth/callback` (w Expo Go przez `exp://127.0.0.1:8081/--/oauth/callback`, dlatego Metro startuje z `--localhost`; w lokalnym `oauth-seed.ts` Core adres Expo Go musi być dodany do `timotime-mobile`). Tokeny trafiają do systemowego sejfu (`expo-secure-store`).

### Baza danych

PostgreSQL z Prismą (ADR-0096), lokalnie w Dockerze na porcie 5435. Serwer łączy się rolą `timo_time_app`, którą zawsze obowiązuje RLS: wpis czasu pracy widzi i zmienia tylko jego właściciel w swojej firmie (ADR-0037). Częściowy indeks unikalny na `ended_at IS NULL` gwarantuje w bazie najwyżej jeden otwarty wpis na osobę.

Zmiana schematu: edytuj `packages/db/prisma/schema.prisma`, wygeneruj migrację w `packages/db` (`pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`) do nowego katalogu w `packages/db/prisma/migrations/` i dodaj polityki RLS dla nowych tabel z danymi osób lub firm.

## Kontrole

```bash
pnpm check              # formatowanie, zgodność wersji, lint, typy, testy (w tym RLS i API), build (wymaga pnpm db:up)
pnpm test               # testy wszystkich paczek i aplikacji
```

## Wersje

Jedna wersja wszystkich części (ADR-0087): Release Please wylicza ją z commitów i aktualizuje `package.json` wszystkich aplikacji i paczek; Expo czyta ją z `apps/mobile/package.json`. `pnpm check:versions` odrzuca każdą rozbieżność.

Wspólne biblioteki `@monorise-team/*` mają w TimoTime zawsze jedną, dokładną wersję. Aktualizacja: Renovate (pull request co tydzień) albo ręcznie `pnpm shared:update` (`latest`, `dev` albo numer wersji).

Zasady pracy: [CONTRIBUTING.md organizacji](https://github.com/Monorise-Team/.github/blob/main/CONTRIBUTING.md).
