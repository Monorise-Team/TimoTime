"use client";

import type { Me } from "@timotime/client";
import { AppBackdrop, Banner, Button, Card, Skeleton } from "@monorise-team/ui";
import { Clock, LogOut, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

function CenteredCardLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <AppBackdrop />
      <main className="flex min-h-dvh items-center justify-center p-6">
        <Card surface="float" className="mr-enter flex w-full max-w-md flex-col gap-4 p-8">
          <div className="flex items-center gap-2 text-sm font-semibold tracking-wide text-text-secondary uppercase">
            <Clock className="size-4 text-accent" aria-hidden />
            TimoTime
          </div>
          {children}
        </Card>
      </main>
    </>
  );
}

/** Stan początkowego ładowania sesji i danych aplikacji. */
export function LoadingView() {
  return (
    <CenteredCardLayout>
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Wczytywanie TimoTime">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="mt-2 h-10 w-full" />
      </div>
    </CenteredCardLayout>
  );
}

/** Ekran wylogowany z opcjonalnym komunikatem o błędzie logowania z `AUTH_ERROR_MESSAGES`. */
export function SignedOutView({
  authError,
  signInHref = "/api/auth/sign-in?returnTo=/",
}: {
  authError: string | null;
  signInHref?: string;
}) {
  return (
    <CenteredCardLayout>
      <h1 className="font-display text-2xl font-semibold">Zaloguj się do TimoTime</h1>
      <p className="text-sm leading-relaxed text-text-secondary">
        Rejestracja czasu pracy korzysta z konta Monorise. Po zalogowaniu zobaczysz swój bieżący status i listę wpisów.
      </p>
      {authError ? <Banner tone="danger" message={authError} /> : null}
      <Button asChild variant="primary" size="lg" className="w-full">
        <a href={signInHref}>Zaloguj się kontem Monorise</a>
      </Button>
    </CenteredCardLayout>
  );
}

/** Błąd połączenia albo wczytania aplikacji przed wyświetleniem widoku głównego. */
export function LoadErrorView({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <CenteredCardLayout>
      <h1 className="font-display text-xl font-semibold">Nie udało się wczytać TimoTime</h1>
      <Banner tone="danger" message={error ?? "Wystąpił nieoczekiwany błąd."} />
      <Button variant="primary" size="md" icon={<RefreshCw aria-hidden />} onClick={onRetry}>
        Spróbuj ponownie
      </Button>
    </CenteredCardLayout>
  );
}

/** Stan zalogowanej osoby bez dostępu do produktu ani widoku zespołu. */
export function NoAccessView({
  me,
  message,
  busy,
  onRetry,
  onSignOut,
}: {
  me: Me;
  message: string;
  busy: boolean;
  onRetry: () => void;
  onSignOut: () => void;
}) {
  return (
    <CenteredCardLayout>
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-xl font-semibold">Brak dostępu do TimoTime</h1>
        <p className="text-xs text-text-secondary">
          {me.employee.fullName} · {me.organization.name}
        </p>
      </div>
      <Banner tone="warning" message={message} />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="md" icon={<RefreshCw aria-hidden />} onClick={onRetry} disabled={busy}>
          Odśwież
        </Button>
        <Button variant="secondary" size="md" icon={<LogOut aria-hidden />} onClick={onSignOut} disabled={busy}>
          Wyloguj
        </Button>
      </div>
    </CenteredCardLayout>
  );
}
