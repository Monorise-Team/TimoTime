-- Baza timo_time i jej role (ADR-0037, ADR-0096), tak jak w MonoriseCore i AvenMail:
-- - timo_time_owner jest właścicielem tabel i uruchamia migracje,
-- - timo_time_app to rola aplikacji: nie jest właścicielem tabel i nie ma BYPASSRLS, więc RLS obowiązuje ją zawsze.
-- Hasła tylko do pracy lokalnej i CI; na serwerze role i hasła zakłada infrastruktura.
CREATE ROLE timo_time_owner LOGIN PASSWORD 'timo_time_owner';
CREATE ROLE timo_time_app LOGIN PASSWORD 'timo_time_app';
CREATE DATABASE timo_time OWNER timo_time_owner;
-- Osobna baza testów lokalnych, żeby testy nie mieszały danych z pracą w przeglądarce
CREATE DATABASE timo_time_test OWNER timo_time_owner;
