"use client";

import {
  ApiError,
  createClient,
  TIME_ENTRY_KIND_LABELS,
  type Me,
  type TimeEntry,
  type TimeEntryKind,
} from "@timotime/client";
import {
  AppBackdrop,
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TextField,
  ThemeProvider,
  type BadgeTone,
} from "@monorise-team/ui";
import { Briefcase, Clock, Coffee, Home, LogOut, Play, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  currentWeekRange,
  entryDurationMs,
  formatDayHeading,
  formatDuration,
  formatLiveClock,
  formatTime,
  groupEntriesByDay,
  todayRange,
  type DayGroup,
} from "@/lib/time-format";

/** Aktualny czas do licznika. Wołane w obsłudze zdarzeń i w efektach, nigdy w renderze. */
function readClock(): number {
  return Date.now();
}

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  expired: "Sesja logowania wygasła. Spróbuj zalogować się ponownie.",
  denied: "Logowanie zostało przerwane.",
  unavailable: "Serwer logowania Monorise jest chwilowo niedostępny.",
  failed: "Nie udało się dokończyć logowania. Spróbuj ponownie.",
};

const STATUS_ACTIONS: { kind: TimeEntryKind; label: string; icon: ReactNode }[] = [
  { kind: "WORK", label: "Rozpocznij pracę", icon: <Play aria-hidden /> },
  { kind: "BREAK", label: "Przerwa", icon: <Coffee aria-hidden /> },
  { kind: "REMOTE", label: "Praca zdalna", icon: <Home aria-hidden /> },
  { kind: "BUSINESS_TRIP", label: "Wyjście służbowe", icon: <Briefcase aria-hidden /> },
];

const KIND_TONES: Record<TimeEntryKind, BadgeTone> = {
  WORK: "success",
  BREAK: "warning",
  REMOTE: "accent",
  BUSINESS_TRIP: "neutral",
};

/** Aplikacja TimoTime w przeglądarce: sesja BFF w ciasteczku HttpOnly, to samo API `/api/v1`. */
export function TimeTrackerApp() {
  return (
    <ThemeProvider>
      <TimeTrackerContent />
    </ThemeProvider>
  );
}

function TimeTrackerContent() {
  const client = useMemo(() => createClient(), []);
  const [me, setMe] = useState<Me | null>(null);
  const [authState, setAuthState] = useState<"loading" | "signed-out" | "signed-in" | "error">("loading");
  const [authError, setAuthError] = useState<string | null>(null);
  const [current, setCurrent] = useState<TimeEntry | null>(null);
  const [todayEntries, setTodayEntries] = useState<TimeEntry[]>([]);
  const [weekEntries, setWeekEntries] = useState<TimeEntry[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const fetchAll = useCallback(async () => {
    const profile = await client.session.me();
    const [active, todayList, weekList] = await Promise.all([
      client.time.current(),
      client.time.entries(todayRange()),
      client.time.entries(currentWeekRange()),
    ]);
    return { profile, active, todayEntries: todayList.entries, weekEntries: weekList.entries };
  }, [client]);

  const loadTimeData = useCallback(async () => {
    const [active, todayList, weekList] = await Promise.all([
      client.time.current(),
      client.time.entries(todayRange()),
      client.time.entries(currentWeekRange()),
    ]);
    setCurrent(active);
    setTodayEntries(todayList.entries);
    setWeekEntries(weekList.entries);
    setNowMs(readClock());
  }, [client]);

  const reload = useCallback(async () => {
    setAuthState("loading");
    setAuthError(null);
    try {
      const data = await fetchAll();
      setMe(data.profile);
      setCurrent(data.active);
      setTodayEntries(data.todayEntries);
      setWeekEntries(data.weekEntries);
      setNowMs(readClock());
      setAuthState("signed-in");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setMe(null);
        setAuthState("signed-out");
        return;
      }
      setAuthError(error instanceof Error ? error.message : "Nie udało się połączyć z serwerem TimoTime.");
      setAuthState("error");
    }
  }, [fetchAll]);

  useEffect(() => {
    let cancelled = false;
    const reason = new URLSearchParams(window.location.search).get("auth_error");
    fetchAll().then(
      (data) => {
        if (cancelled) return;
        setMe(data.profile);
        setCurrent(data.active);
        setTodayEntries(data.todayEntries);
        setWeekEntries(data.weekEntries);
        setNowMs(readClock());
        setAuthState("signed-in");
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          setMe(null);
          if (reason) {
            setAuthError(AUTH_ERROR_MESSAGES[reason] ?? AUTH_ERROR_MESSAGES.failed ?? "Nie udało się zalogować.");
          }
          setAuthState("signed-out");
          return;
        }
        setAuthError(error instanceof Error ? error.message : "Nie udało się połączyć z serwerem TimoTime.");
        setAuthState("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fetchAll]);

  useEffect(() => {
    if (!current) return;
    const timer = window.setInterval(() => setNowMs(readClock()), 1000);
    return () => window.clearInterval(timer);
  }, [current]);

  async function handleStart(kind: TimeEntryKind) {
    setBusy(true);
    setActionError(null);
    try {
      const trimmed = note.trim();
      await client.time.start({ kind, note: trimmed || undefined });
      setNote("");
      setNowMs(readClock());
      await loadTimeData();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setAuthState("signed-out");
        return;
      }
      setActionError(error instanceof Error ? error.message : "Nie udało się rozpocząć wpisu.");
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setBusy(true);
    setActionError(null);
    try {
      await client.time.stop();
      setNowMs(readClock());
      await loadTimeData();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setAuthState("signed-out");
        return;
      }
      setActionError(error instanceof Error ? error.message : "Nie udało się zakończyć wpisu.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    setBusy(true);
    try {
      await client.session.signOut();
      setMe(null);
      setCurrent(null);
      setTodayEntries([]);
      setWeekEntries([]);
      setAuthState("signed-out");
    } finally {
      setBusy(false);
    }
  }

  const todayGroups = useMemo(() => groupEntriesByDay(todayEntries, nowMs), [todayEntries, nowMs]);
  const weekGroups = useMemo(() => groupEntriesByDay(weekEntries, nowMs), [weekEntries, nowMs]);

  if (authState === "loading") {
    return (
      <>
        <AppBackdrop />
        <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-4 px-4 py-8">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-64 w-full" />
        </main>
      </>
    );
  }

  if (authState === "signed-out") {
    return (
      <>
        <AppBackdrop />
        <main className="flex min-h-dvh items-center justify-center p-6">
          <Card surface="float" className="flex w-full max-w-md flex-col gap-4 p-8">
            <div className="flex items-center gap-2 text-sm font-semibold tracking-wide text-text-secondary uppercase">
              <Clock className="size-4 text-accent" aria-hidden />
              TimoTime
            </div>
            <h1 className="font-display text-2xl font-semibold">Zaloguj się do TimoTime</h1>
            <p className="text-sm leading-relaxed text-text-secondary">
              Rejestracja czasu pracy korzysta z konta Monorise. Po zalogowaniu zobaczysz swój bieżący status i listę
              wpisów.
            </p>
            {authError ? (
              <p role="alert" className="rounded-control bg-danger/10 px-3 py-2 text-sm text-danger">
                {authError}
              </p>
            ) : null}
            <Button asChild variant="primary" size="lg" className="w-full">
              <a href="/api/auth/sign-in?returnTo=/">Zaloguj się kontem Monorise</a>
            </Button>
          </Card>
        </main>
      </>
    );
  }

  if (authState === "error" || !me) {
    return (
      <>
        <AppBackdrop />
        <main className="flex min-h-dvh items-center justify-center p-6">
          <Card surface="float" className="flex w-full max-w-md flex-col gap-4 p-8">
            <h1 className="font-display text-xl font-semibold">Nie udało się wczytać TimoTime</h1>
            <p role="alert" className="text-sm text-danger">
              {authError ?? "Wystąpił nieoczekiwany błąd."}
            </p>
            <Button variant="primary" size="md" onClick={() => void reload()}>
              Spróbuj ponownie
            </Button>
          </Card>
        </main>
      </>
    );
  }

  const elapsedMs = current ? entryDurationMs(current, nowMs) : 0;

  return (
    <>
      <AppBackdrop />
      <div className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-5 px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-xl bg-accent text-accent-fg">
              <Clock className="size-4" aria-hidden />
            </span>
            <div>
              <p className="text-sm font-semibold">TimoTime</p>
              <p className="text-xs text-text-secondary">
                {me.employee.fullName} · {me.organization.name}
              </p>
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={<LogOut aria-hidden />}
            onClick={() => void handleSignOut()}
            disabled={busy}
          >
            Wyloguj
          </Button>
        </header>

        <main className="flex flex-col gap-5">
          <Card surface="reading" className="flex flex-col gap-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium tracking-wide text-text-tertiary uppercase">Bieżący status</span>
                <div className="flex items-center gap-2.5">
                  <Badge tone={current ? KIND_TONES[current.kind] : "neutral"} className="px-2.5">
                    {current ? TIME_ENTRY_KIND_LABELS[current.kind] : "Poza pracą"}
                  </Badge>
                  {current ? (
                    <span className="text-xs text-text-secondary">od {formatTime(current.startedAt)}</span>
                  ) : null}
                </div>
              </div>
              <p
                aria-live="off"
                className="font-mono text-2xl font-semibold tracking-tight text-text-primary tabular-nums"
              >
                {current ? formatLiveClock(elapsedMs) : "00:00:00"}
              </p>
            </div>

            {current?.note ? <p className="text-sm text-text-secondary">Notatka: {current.note}</p> : null}

            <TextField
              label="Notatka do nowego wpisu (opcjonalnie)"
              placeholder="Np. spotkanie z klientem, prace w magazynie"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={500}
              disabled={busy}
            />

            <div className="flex flex-wrap gap-2" role="group" aria-label="Zmiana statusu czasu pracy">
              {STATUS_ACTIONS.map((action) => {
                const isActive = current?.kind === action.kind;
                return (
                  <Button
                    key={action.kind}
                    variant={isActive ? "primary" : "outline"}
                    size="md"
                    icon={action.icon}
                    onClick={() => void handleStart(action.kind)}
                    disabled={busy}
                    aria-pressed={isActive}
                  >
                    {action.label}
                  </Button>
                );
              })}
              <Button
                variant="danger"
                size="md"
                icon={<Square aria-hidden />}
                onClick={() => void handleStop()}
                disabled={busy || !current}
              >
                Zakończ
              </Button>
            </div>

            {actionError ? (
              <p role="alert" className="text-sm text-danger">
                {actionError}
              </p>
            ) : null}
          </Card>

          <Card surface="middle" className="flex flex-col">
            <Tabs defaultValue="today" className="flex flex-col">
              <CardHeader className="justify-between">
                <CardTitle>Wpisy czasu pracy</CardTitle>
                <TabsList aria-label="Zakres wpisów">
                  <TabsTrigger value="today">Dzisiaj</TabsTrigger>
                  <TabsTrigger value="week">Ten tydzień</TabsTrigger>
                </TabsList>
              </CardHeader>

              <TabsContent value="today" className="p-4">
                <DayGroupList
                  groups={todayGroups}
                  nowMs={nowMs}
                  emptyTitle="Brak wpisów z dzisiaj"
                  emptyDescription="Kliknij Rozpocznij pracę albo inny status powyżej, aby dodać pierwszy wpis."
                />
              </TabsContent>

              <TabsContent value="week" className="p-4">
                <DayGroupList
                  groups={weekGroups}
                  nowMs={nowMs}
                  emptyTitle="Brak wpisów w tym tygodniu"
                  emptyDescription="Wszystkie wpisy od poniedziałku do niedzieli pojawią się w tym miejscu."
                />
              </TabsContent>
            </Tabs>
          </Card>
        </main>
      </div>
    </>
  );
}

function DayGroupList({
  groups,
  nowMs,
  emptyTitle,
  emptyDescription,
}: {
  groups: DayGroup[];
  nowMs: number;
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (groups.length === 0) {
    return <EmptyState icon={<Clock aria-hidden />} title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <section key={group.dateKey} aria-label={formatDayHeading(group.dateKey)} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border-secondary pb-1.5">
            <h3 className="text-sm font-semibold text-text-primary">{formatDayHeading(group.dateKey)}</h3>
            <div className="flex items-center gap-3 text-xs text-text-secondary tabular-nums">
              <span>Suma pracy: {formatDuration(group.workMs)}</span>
              {group.breakMs > 0 ? <span>Przerwy: {formatDuration(group.breakMs)}</span> : null}
            </div>
          </div>

          <ul className="flex flex-col gap-1.5">
            {group.entries.map((entry) => {
              const duration = entryDurationMs(entry, nowMs);
              return (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-row bg-bg-tertiary/60 px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={KIND_TONES[entry.kind]} className="px-2">
                      {TIME_ENTRY_KIND_LABELS[entry.kind]}
                    </Badge>
                    <span className="text-sm text-text-primary tabular-nums">
                      {formatTime(entry.startedAt)} do {entry.endedAt ? formatTime(entry.endedAt) : "teraz"}
                    </span>
                    {entry.note ? <span className="text-xs text-text-secondary">({entry.note})</span> : null}
                  </div>
                  <span className="text-sm font-medium text-text-primary tabular-nums">{formatDuration(duration)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
