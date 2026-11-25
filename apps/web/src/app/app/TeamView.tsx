"use client";

import { ApiError, TIME_ENTRY_KIND_LABELS, type TeamTimeEntry, type TimoTimeClient } from "@timotime/client";
import { Badge, Banner, Button, Card, CardHeader, CardTitle, EmptyState, Skeleton } from "@monorise-team/ui";
import { Clock, RefreshCw, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { entryDurationMs, formatDuration, formatTime, groupTeamEntriesByEmployee, todayRange } from "@/lib/time-format";
import { KIND_TONES, readClock } from "./app-views";

export interface TeamViewProps {
  client: TimoTimeClient;
  onUnauthorized: () => void;
  /** Zwiększany przez paletę poleceń („Odśwież”), aby przeładować dane zespołu. */
  refreshSignal: number;
}

/** Widok „Zespół” dla kierowników i właścicieli: aktywne statusy oraz dzisiejsze wpisy zespołu. */
export function TeamView({ client, onUnauthorized, refreshSignal }: TeamViewProps) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentEntries, setCurrentEntries] = useState<TeamTimeEntry[]>([]);
  const [todayEntries, setTodayEntries] = useState<TeamTimeEntry[]>([]);
  const [nowMs, setNowMs] = useState(0);
  const lastRefreshSignal = useRef(refreshSignal);

  const fetchTeamData = useCallback(async () => {
    const [activeList, entriesList] = await Promise.all([client.team.current(), client.team.entries(todayRange())]);
    return { activeEntries: activeList.entries, todayEntries: entriesList.entries };
  }, [client]);

  const reloadTeam = useCallback(
    async (isRefresh: boolean) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const data = await fetchTeamData();
        setCurrentEntries(data.activeEntries);
        setTodayEntries(data.todayEntries);
        setNowMs(readClock());
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized();
          return;
        }
        setError(err instanceof Error ? err.message : "Nie udało się wczytać danych zespołu.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [fetchTeamData, onUnauthorized],
  );

  useEffect(() => {
    let cancelled = false;
    fetchTeamData().then(
      (data) => {
        if (cancelled) return;
        setCurrentEntries(data.activeEntries);
        setTodayEntries(data.todayEntries);
        setNowMs(readClock());
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized();
          return;
        }
        setError(err instanceof Error ? err.message : "Nie udało się wczytać danych zespołu.");
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fetchTeamData, onUnauthorized]);

  useEffect(() => {
    if (refreshSignal === lastRefreshSignal.current) return;
    lastRefreshSignal.current = refreshSignal;
    void reloadTeam(true);
  }, [refreshSignal, reloadTeam]);

  useEffect(() => {
    if (currentEntries.length === 0) return;
    const timer = window.setInterval(() => setNowMs(readClock()), 1000);
    return () => window.clearInterval(timer);
  }, [currentEntries.length]);

  const employeeGroups = useMemo(
    () => (nowMs === 0 ? [] : groupTeamEntriesByEmployee(todayEntries, nowMs, todayRange(new Date(nowMs)))),
    [todayEntries, nowMs],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-text-primary">Zespół</h1>
        <Button
          variant="secondary"
          size="sm"
          icon={<RefreshCw aria-hidden />}
          onClick={() => void reloadTeam(true)}
          disabled={loading || refreshing}
        >
          {refreshing ? "Odświeżanie…" : "Odśwież"}
        </Button>
      </div>

      {error ? (
        <Banner
          tone="danger"
          title="Nie udało się wczytać widoku zespołu"
          message={error}
          action={{ label: "Spróbuj ponownie", onClick: () => void reloadTeam(false) }}
        />
      ) : null}

      {loading ? (
        <div className="flex flex-col gap-4" aria-busy="true" aria-label="Wczytywanie danych zespołu">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      ) : error ? null : (
        <>
          <Card surface="middle" className="flex flex-col">
            <CardHeader className="justify-between">
              <div className="flex items-center gap-2">
                <CardTitle>Kto teraz pracuje</CardTitle>
                <Badge tone={currentEntries.length > 0 ? "success" : "neutral"}>{currentEntries.length}</Badge>
              </div>
            </CardHeader>

            <div className="p-4">
              {currentEntries.length === 0 ? (
                <EmptyState
                  icon={<Users aria-hidden />}
                  title="Nikt teraz nie pracuje"
                  description="Gdy osoby z Twojego zespołu rozpoczną pracę, ich bieżący status pojawi się tutaj."
                />
              ) : (
                <ul className="flex flex-col gap-2">
                  {currentEntries.map((entry) => {
                    const fullName = `${entry.employee.firstName} ${entry.employee.lastName}`.trim();
                    return (
                      <li
                        key={entry.id}
                        className="mr-row flex flex-wrap items-center justify-between gap-2 bg-bg-tertiary/60 px-[var(--mr-row-px)] py-[var(--mr-row-py)]"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-text-primary">{fullName}</span>
                          <Badge tone={KIND_TONES[entry.kind]} className="px-2">
                            {TIME_ENTRY_KIND_LABELS[entry.kind]}
                          </Badge>
                          <span className="text-xs text-text-secondary tabular-nums">
                            od {formatTime(entry.startedAt)}
                          </span>
                          {entry.note ? <span className="text-xs text-text-secondary">({entry.note})</span> : null}
                        </div>
                        <span className="text-sm font-medium text-text-primary tabular-nums">
                          {formatDuration(entryDurationMs(entry, nowMs))}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Card>

          <Card surface="middle" className="flex flex-col">
            <CardHeader>
              <CardTitle>Dzisiejsze wpisy zespołu</CardTitle>
            </CardHeader>

            <div className="p-4">
              {employeeGroups.length === 0 ? (
                <EmptyState
                  icon={<Clock aria-hidden />}
                  title="Brak wpisów zespołu z dzisiaj"
                  description="Dzisiejsze wpisy czasu pracy osób z Twojego zespołu pojawią się w tym miejscu."
                />
              ) : (
                <div className="flex flex-col gap-5">
                  {employeeGroups.map((group) => (
                    <section key={group.employee.id} aria-label={group.fullName} className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border-secondary pb-1.5">
                        <h3 className="text-sm font-semibold text-text-primary">{group.fullName}</h3>
                        <div className="flex items-center gap-3 text-xs text-text-secondary tabular-nums">
                          <span>Suma pracy: {formatDuration(group.workMs)}</span>
                          {group.breakMs > 0 ? <span>Przerwy: {formatDuration(group.breakMs)}</span> : null}
                        </div>
                      </div>

                      <ul className="flex flex-col gap-1.5">
                        {group.entries.map((slice) => {
                          const { entry } = slice;
                          const startLabel = slice.startedBeforeRange ? "00:00" : formatTime(entry.startedAt);
                          const endLabel = slice.endedAfterRange
                            ? "24:00"
                            : entry.endedAt
                              ? formatTime(entry.endedAt)
                              : "teraz";
                          return (
                            <li
                              key={entry.id}
                              className="mr-row flex flex-wrap items-center justify-between gap-2 bg-bg-tertiary/60 px-[var(--mr-row-px)] py-[var(--mr-row-py)]"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge tone={KIND_TONES[entry.kind]} className="px-2">
                                  {TIME_ENTRY_KIND_LABELS[entry.kind]}
                                </Badge>
                                <span className="text-sm text-text-primary tabular-nums">
                                  {startLabel} do {endLabel}
                                </span>
                                {entry.note ? (
                                  <span className="text-xs text-text-secondary">({entry.note})</span>
                                ) : null}
                              </div>
                              <span className="text-sm font-medium text-text-primary tabular-nums">
                                {formatDuration(slice.durationMs)}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
