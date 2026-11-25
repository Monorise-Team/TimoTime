"use client";

import { TIME_ENTRY_KIND_LABELS, type TimeEntry, type TimeEntryKind } from "@timotime/client";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHeader,
  CardTitle,
  EmptyState,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TextField,
} from "@monorise-team/ui";
import { Briefcase, Clock, Coffee, Home, Play, RefreshCw, Square } from "lucide-react";
import type { ReactNode } from "react";
import {
  entryDurationMs,
  formatDayHeading,
  formatDuration,
  formatLiveClock,
  formatTime,
  type DayGroup,
} from "@/lib/time-format";
import { KIND_TONES } from "./app-views";

const STATUS_ACTIONS: { kind: TimeEntryKind; label: string; icon: ReactNode }[] = [
  { kind: "WORK", label: "Rozpocznij pracę", icon: <Play aria-hidden /> },
  { kind: "BREAK", label: "Przerwa", icon: <Coffee aria-hidden /> },
  { kind: "REMOTE", label: "Praca zdalna", icon: <Home aria-hidden /> },
  { kind: "BUSINESS_TRIP", label: "Wyjście służbowe", icon: <Briefcase aria-hidden /> },
];

export interface MyTimeViewProps {
  canTrackOwn: boolean;
  canViewTeam: boolean;
  accessDeniedMessage: string | null;
  current: TimeEntry | null;
  nowMs: number;
  note: string;
  onNoteChange: (value: string) => void;
  busy: boolean;
  refreshing: boolean;
  todayGroups: DayGroup[];
  weekGroups: DayGroup[];
  onStart: (kind: TimeEntryKind) => void;
  onStop: () => void;
  onRefresh: () => void;
  onGoToTeam: () => void;
}

/** Widok „Mój czas”: bieżący status z licznikiem, szybkie akcje oraz lista wpisów z dzisiaj i tygodnia. */
export function MyTimeView({
  canTrackOwn,
  canViewTeam,
  accessDeniedMessage,
  current,
  nowMs,
  note,
  onNoteChange,
  busy,
  refreshing,
  todayGroups,
  weekGroups,
  onStart,
  onStop,
  onRefresh,
  onGoToTeam,
}: MyTimeViewProps) {
  const elapsedMs = current ? entryDurationMs(current, nowMs) : 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-text-primary">Mój czas</h1>
        <Button
          variant="secondary"
          size="sm"
          icon={<RefreshCw aria-hidden />}
          onClick={onRefresh}
          disabled={busy || refreshing}
        >
          {refreshing ? "Odświeżanie…" : "Odśwież"}
        </Button>
      </div>

      {!canTrackOwn ? (
        <Banner
          tone="warning"
          title="Brak uprawnienia do rejestracji własnego czasu"
          message={accessDeniedMessage ?? "Twoje konto ma dostęp wyłącznie do widoku zespołu."}
          action={canViewTeam ? { label: "Przejdź do zespołu", onClick: onGoToTeam } : undefined}
        />
      ) : (
        <>
          <Card surface="middle" className="flex flex-col gap-4 p-5">
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
              onChange={(event) => onNoteChange(event.target.value)}
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
                    onClick={() => onStart(action.kind)}
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
                onClick={onStop}
                disabled={busy || !current}
              >
                Zakończ
              </Button>
            </div>
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
                  emptyTitle="Brak wpisów z dzisiaj"
                  emptyDescription="Kliknij Rozpocznij pracę albo inny status powyżej, aby dodać pierwszy wpis."
                />
              </TabsContent>

              <TabsContent value="week" className="p-4">
                <DayGroupList
                  groups={weekGroups}
                  emptyTitle="Brak wpisów w tym tygodniu"
                  emptyDescription="Wszystkie wpisy od poniedziałku do niedzieli pojawią się w tym miejscu."
                />
              </TabsContent>
            </Tabs>
          </Card>
        </>
      )}
    </div>
  );
}

function DayGroupList({
  groups,
  emptyTitle,
  emptyDescription,
}: {
  groups: DayGroup[];
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
            {group.entries.map((slice) => {
              const { entry } = slice;
              const startLabel = slice.startedBeforeDay ? "00:00" : formatTime(entry.startedAt);
              const endLabel = slice.endedAfterDay ? "24:00" : entry.endedAt ? formatTime(entry.endedAt) : "teraz";
              return (
                <li
                  key={`${group.dateKey}:${entry.id}`}
                  className="mr-row flex flex-wrap items-center justify-between gap-2 bg-bg-tertiary/60 px-[var(--mr-row-px)] py-[var(--mr-row-py)]"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={KIND_TONES[entry.kind]} className="px-2">
                      {TIME_ENTRY_KIND_LABELS[entry.kind]}
                    </Badge>
                    <span className="text-sm text-text-primary tabular-nums">
                      {startLabel} do {endLabel}
                    </span>
                    {entry.note ? <span className="text-xs text-text-secondary">({entry.note})</span> : null}
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
  );
}
