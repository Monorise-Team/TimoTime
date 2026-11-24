# Instrukcje dla GitHub Copilot

<!-- monorise:generated z Monorise-Team/.github (templates/agents/copilot-instructions.md); zmieniaj wzorzec, nie ten plik -->

Zasady pracy są w pliku `AGENTS.md` w katalogu głównym repozytorium: najpierw wspólne zasady Monorise, potem zasady tego repozytorium. Przeczytaj go przed każdym zadaniem i przeglądem kodu.

Uwagi w przeglądzie pisz po polsku, prostym językiem, z wyjaśnieniem skutku (np. „Anna z firmy Acme zobaczy dane innej firmy”).

Przy przeglądzie kodu sprawdzaj przede wszystkim:

- sekrety, hasła, tokeny i dane osobowe w kodzie, logach i komunikatach błędów;
- firmę i osobę zawsze z tokenu albo sesji, nigdy z treści żądania, a dane firm tylko przez RLS;
- odpowiedzi API w formacie `{ data, meta, error }` ze stałymi kodami błędów;
- wygląd tylko z `@monorise-team/ui` i tokenów, bez kolorów wpisanych na sztywno;
- test dla nowego zachowania, teksty interfejsu po polsku i aktualne README.
