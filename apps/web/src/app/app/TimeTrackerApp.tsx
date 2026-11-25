"use client";

import {
  ApiError,
  createClient,
  TIME_ENTRY_KIND_LABELS,
  type Me,
  type TimeEntry,
  type TimeEntryKind,
} from "@timotime/client";
import { ThemeProvider, ToastProvider, useToast } from "@monorise-team/ui";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { currentWeekRange, groupEntriesByDay, todayRange } from "@/lib/time-format";
import { AppearanceView } from "./AppearanceView";
import { MyTimeView } from "./MyTimeView";
import { LoadErrorView, LoadingView, NoAccessView, SignedOutView } from "./SignedOutView";
import { TeamView } from "./TeamView";
import { TimoTimeShell } from "./TimoTimeShell";
import {
  AUTH_ERROR_MESSAGES,
  DEFAULT_NO_ACCESS_MESSAGE,
  VIEW_HASHES,
  formatStartToastTitle,
  formatStopToastTitle,
  isAccessDeniedError,
  parseViewFromHash,
  readClock,
  type AppView,
} from "./app-views";

function subscribeHash(onStoreChange: () => void): () => void {
  window.addEventListener("hashchange", onStoreChange);
  window.addEventListener("popstate", onStoreChange);
  return () => {
    window.removeEventListener("hashchange", onStoreChange);
    window.removeEventListener("popstate", onStoreChange);
  };
}

function getHashSnapshot(): string {
  return window.location.hash;
}

function getServerHashSnapshot(): string {
  return "";
}

/** Aplikacja TimoTime w przeglądarce: sesja BFF w ciasteczku HttpOnly, to samo API `/api/v1`. */
export function TimeTrackerApp() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <TimeTrackerContent />
      </ToastProvider>
    </ThemeProvider>
  );
}

function TimeTrackerContent() {
  const client = useMemo(() => createClient(), []);
  const { toast } = useToast();
  const hash = useSyncExternalStore(subscribeHash, getHashSnapshot, getServerHashSnapshot);

  const [me, setMe] = useState<Me | null>(null);
  const [authState, setAuthState] = useState<"loading" | "signed-out" | "signed-in" | "error">("loading");
  const [authError, setAuthError] = useState<string | null>(null);
  const [accessDeniedMessage, setAccessDeniedMessage] = useState<string | null>(null);
  const [current, setCurrent] = useState<TimeEntry | null>(null);
  const [todayEntries, setTodayEntries] = useState<TimeEntry[]>([]);
  const [weekEntries, setWeekEntries] = useState<TimeEntry[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(0);
  const [teamRefreshSignal, setTeamRefreshSignal] = useState(0);

  const fetchAll = useCallback(async () => {
    const profile = await client.session.me();

    if (!profile.capabilities.trackOwnTime) {
      let deniedMessage: string | null = null;
      if (!profile.capabilities.viewTeam) {
        try {
          await client.time.current();
        } catch (error) {
          if (isAccessDeniedError(error)) {
            deniedMessage = error.message;
          } else {
            throw error;
          }
        }
        deniedMessage ??= DEFAULT_NO_ACCESS_MESSAGE;
      }
      return {
        profile,
        deniedMessage,
        active: null as TimeEntry | null,
        todayEntries: [] as TimeEntry[],
        weekEntries: [] as TimeEntry[],
      };
    }

    try {
      const [active, todayList, weekList] = await Promise.all([
        client.time.current(),
        client.time.entries(todayRange()),
        client.time.entries(currentWeekRange()),
      ]);
      return {
        profile,
        deniedMessage: null,
        active,
        todayEntries: todayList.entries,
        weekEntries: weekList.entries,
      };
    } catch (error) {
      if (isAccessDeniedError(error)) {
        return {
          profile,
          deniedMessage: error.message,
          active: null as TimeEntry | null,
          todayEntries: [] as TimeEntry[],
          weekEntries: [] as TimeEntry[],
        };
      }
      throw error;
    }
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
    setAccessDeniedMessage(null);
    setNowMs(readClock());
  }, [client]);

  const reload = useCallback(async () => {
    setAuthState("loading");
    setAuthError(null);
    setAccessDeniedMessage(null);
    try {
      const data = await fetchAll();
      setMe(data.profile);
      setAccessDeniedMessage(data.deniedMessage);
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

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setActionError(null);
    setTeamRefreshSignal((value) => value + 1);
    try {
      const data = await fetchAll();
      setMe(data.profile);
      setAccessDeniedMessage(data.deniedMessage);
      setCurrent(data.active);
      setTodayEntries(data.todayEntries);
      setWeekEntries(data.weekEntries);
      setNowMs(readClock());
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setMe(null);
        setAuthState("signed-out");
        return;
      }
      setActionError(error instanceof Error ? error.message : "Nie udało się odświeżyć danych.");
    } finally {
      setRefreshing(false);
    }
  }, [fetchAll]);

  useEffect(() => {
    let cancelled = false;
    const reason = new URLSearchParams(window.location.search).get("auth_error");
    fetchAll().then(
      (data) => {
        if (cancelled) return;
        setMe(data.profile);
        setAccessDeniedMessage(data.deniedMessage);
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

  const handleStart = useCallback(
    async (kind: TimeEntryKind) => {
      setBusy(true);
      setActionError(null);
      try {
        const trimmed = note.trim();
        const started = await client.time.start({ kind, note: trimmed || undefined });
        setNote("");
        setNowMs(readClock());
        await loadTimeData();
        toast({ title: formatStartToastTitle(started), tone: "success" });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          setAuthState("signed-out");
          return;
        }
        if (isAccessDeniedError(error)) {
          setAccessDeniedMessage(error.message);
          return;
        }
        setActionError(error instanceof Error ? error.message : "Nie udało się rozpocząć wpisu.");
      } finally {
        setBusy(false);
      }
    },
    [client, loadTimeData, note, toast],
  );

  const handleStop = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      const stopped = await client.time.stop();
      const stoppedAtMs = readClock();
      setNowMs(stoppedAtMs);
      await loadTimeData();
      toast({
        title: formatStopToastTitle(stopped, stoppedAtMs),
        description: TIME_ENTRY_KIND_LABELS[stopped.kind],
        tone: "success",
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setAuthState("signed-out");
        return;
      }
      if (isAccessDeniedError(error)) {
        setAccessDeniedMessage(error.message);
        return;
      }
      setActionError(error instanceof Error ? error.message : "Nie udało się zakończyć wpisu.");
    } finally {
      setBusy(false);
    }
  }, [client, loadTimeData, toast]);

  const handleSignOut = useCallback(async () => {
    setBusy(true);
    try {
      await client.session.signOut();
      setMe(null);
      setCurrent(null);
      setTodayEntries([]);
      setWeekEntries([]);
      setAccessDeniedMessage(null);
      setActionError(null);
      setAuthState("signed-out");
    } finally {
      setBusy(false);
    }
  }, [client]);

  const handleUnauthorized = useCallback(() => {
    setMe(null);
    setAuthState("signed-out");
  }, []);

  const navigateTo = useCallback((view: AppView) => {
    const nextHash = VIEW_HASHES[view];
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
  }, []);

  const dismissActionError = useCallback(() => {
    setActionError(null);
  }, []);

  const handleStartClick = useCallback(
    (kind: TimeEntryKind) => {
      void handleStart(kind);
    },
    [handleStart],
  );

  const handleStopClick = useCallback(() => {
    void handleStop();
  }, [handleStop]);

  const handleRefreshClick = useCallback(() => {
    void handleRefresh();
  }, [handleRefresh]);

  const handleSignOutClick = useCallback(() => {
    void handleSignOut();
  }, [handleSignOut]);

  const handleGoToTeam = useCallback(() => {
    navigateTo("team");
  }, [navigateTo]);

  const todayGroups = useMemo(
    () => (nowMs === 0 ? [] : groupEntriesByDay(todayEntries, nowMs, todayRange(new Date(nowMs)))),
    [todayEntries, nowMs],
  );
  const weekGroups = useMemo(
    () => (nowMs === 0 ? [] : groupEntriesByDay(weekEntries, nowMs, currentWeekRange(new Date(nowMs)))),
    [weekEntries, nowMs],
  );

  if (authState === "loading") {
    return <LoadingView />;
  }

  if (authState === "signed-out") {
    return <SignedOutView authError={authError} />;
  }

  if (authState === "error" || !me) {
    return <LoadErrorView error={authError} onRetry={() => void reload()} />;
  }

  const canTrackOwn = me.capabilities.trackOwnTime && !accessDeniedMessage;
  const canViewTeam = me.capabilities.viewTeam;

  if (!canTrackOwn && !canViewTeam) {
    return (
      <NoAccessView
        me={me}
        message={accessDeniedMessage ?? DEFAULT_NO_ACCESS_MESSAGE}
        busy={busy}
        onRetry={() => void reload()}
        onSignOut={() => void handleSignOut()}
      />
    );
  }

  const activeView = parseViewFromHash(hash, { canViewTeam, canTrackOwn });

  return (
    <TimoTimeShell
      organizationName={me.organization.name}
      personName={me.employee.fullName}
      view={activeView}
      canTrackOwn={canTrackOwn}
      canViewTeam={canViewTeam}
      hasActiveEntry={current !== null}
      busy={busy}
      actionError={actionError}
      onDismissActionError={dismissActionError}
      onNavigate={navigateTo}
      onStart={handleStartClick}
      onStop={handleStopClick}
      onRefresh={handleRefreshClick}
      onSignOut={handleSignOutClick}
    >
      {activeView === "appearance" ? (
        <AppearanceView />
      ) : activeView === "team" ? (
        <TeamView client={client} onUnauthorized={handleUnauthorized} refreshSignal={teamRefreshSignal} />
      ) : (
        <MyTimeView
          canTrackOwn={canTrackOwn}
          canViewTeam={canViewTeam}
          accessDeniedMessage={accessDeniedMessage}
          current={current}
          nowMs={nowMs}
          note={note}
          onNoteChange={setNote}
          busy={busy}
          refreshing={refreshing}
          todayGroups={todayGroups}
          weekGroups={weekGroups}
          onStart={handleStartClick}
          onStop={handleStopClick}
          onRefresh={handleRefreshClick}
          onGoToTeam={handleGoToTeam}
        />
      )}
    </TimoTimeShell>
  );
}
