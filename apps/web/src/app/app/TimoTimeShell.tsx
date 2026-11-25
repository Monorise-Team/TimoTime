"use client";

import type { TimeEntryKind } from "@timotime/client";
import {
  AppShell,
  Banner,
  Card,
  CommandPalette,
  ShortcutsHelp,
  SidebarCollapseButton,
  SidebarItem,
  SidebarLink,
  SidebarNav,
  SidebarShell,
  cn,
  useCommandPalette,
  useHotkeys,
  useSidebar,
  type CommandPaletteGroup,
  type CommandPaletteItem,
  type ShortcutHelpCategory,
} from "@monorise-team/ui";
import {
  Briefcase,
  Clock,
  Coffee,
  Home,
  Keyboard,
  LogOut,
  Palette,
  Play,
  RefreshCw,
  Square,
  Users,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { VIEW_HASHES, type AppView } from "./app-views";

export interface TimoTimeShellProps {
  organizationName: string;
  personName: string;
  view: AppView;
  canTrackOwn: boolean;
  canViewTeam: boolean;
  hasActiveEntry: boolean;
  busy: boolean;
  actionError: string | null;
  onDismissActionError: () => void;
  onNavigate: (view: AppView) => void;
  onStart: (kind: TimeEntryKind) => void;
  onStop: () => void;
  onRefresh: () => void;
  onSignOut: () => void;
  children: ReactNode;
}

/**
 * Szkielet zalogowanej aplikacji TimoTime: tapeta pod szklanymi kartami, zwijany pasek boczny,
 * aktywny widok na karcie do czytania, paleta poleceń (⌘K / Ctrl+K) oraz skróty `g …` i `?`.
 */
export function TimoTimeShell({
  organizationName,
  personName,
  view,
  canTrackOwn,
  canViewTeam,
  hasActiveEntry,
  busy,
  actionError,
  onDismissActionError,
  onNavigate,
  onStart,
  onStop,
  onRefresh,
  onSignOut,
  children,
}: TimoTimeShellProps) {
  const palette = useCommandPalette();
  const [helpOpen, setHelpOpen] = useState(false);

  const hotkeys = useMemo(
    () => [
      { shortcut: "g m", handler: () => onNavigate("my-time") },
      ...(canViewTeam ? [{ shortcut: "g z", handler: () => onNavigate("team") }] : []),
      { shortcut: "g w", handler: () => onNavigate("appearance") },
    ],
    [canViewTeam, onNavigate],
  );

  useHotkeys(hotkeys, { ignoreWhenModalOpen: true });

  const groups = useMemo<CommandPaletteGroup[]>(() => {
    const goItems: CommandPaletteItem[] = [
      {
        id: "go-my-time",
        label: "Mój czas",
        icon: <Clock size={16} aria-hidden />,
        shortcut: "g m",
        keywords: ["czas", "moj", "status", "wpisy", "zegar"],
        onSelect: () => onNavigate("my-time"),
      },
      ...(canViewTeam
        ? [
            {
              id: "go-team",
              label: "Zespół",
              icon: <Users size={16} aria-hidden />,
              shortcut: "g z",
              keywords: ["zespol", "pracownicy", "kierownik", "ludzie"],
              onSelect: () => onNavigate("team"),
            },
          ]
        : []),
      {
        id: "go-appearance",
        label: "Wygląd",
        icon: <Palette size={16} aria-hidden />,
        shortcut: "g w",
        keywords: ["wyglad", "motyw", "ciemny", "jasny", "tapeta", "ustawienia"],
        onSelect: () => onNavigate("appearance"),
      },
      {
        id: "go-shortcuts",
        label: "Skróty klawiszowe",
        icon: <Keyboard size={16} aria-hidden />,
        shortcut: "shift+?",
        keywords: ["skroty", "klawiatura", "pomoc", "klawisze"],
        onSelect: () => setHelpOpen(true),
      },
    ];

    const actionItems: CommandPaletteItem[] = [
      ...(canTrackOwn
        ? [
            {
              id: "action-work",
              label: "Rozpocznij pracę",
              icon: <Play size={16} aria-hidden />,
              keywords: ["start", "praca", "rozpocznij", "pracuj"],
              disabled: busy,
              onSelect: () => onStart("WORK"),
            },
            {
              id: "action-break",
              label: "Przerwa",
              icon: <Coffee size={16} aria-hidden />,
              keywords: ["przerwa", "pauza", "kawa", "obiad"],
              disabled: busy,
              onSelect: () => onStart("BREAK"),
            },
            {
              id: "action-remote",
              label: "Praca zdalna",
              icon: <Home size={16} aria-hidden />,
              keywords: ["zdalna", "dom", "remote", "home"],
              disabled: busy,
              onSelect: () => onStart("REMOTE"),
            },
            {
              id: "action-business-trip",
              label: "Wyjście służbowe",
              icon: <Briefcase size={16} aria-hidden />,
              keywords: ["wyjscie", "sluzbowe", "delegacja", "teren", "klient"],
              disabled: busy,
              onSelect: () => onStart("BUSINESS_TRIP"),
            },
          ]
        : []),
      ...(canTrackOwn && hasActiveEntry
        ? [
            {
              id: "action-stop",
              label: "Zakończ",
              icon: <Square size={16} aria-hidden />,
              keywords: ["stop", "zakoncz", "koniec", "zatrzymaj"],
              disabled: busy,
              onSelect: onStop,
            },
          ]
        : []),
      {
        id: "action-refresh",
        label: "Odśwież",
        icon: <RefreshCw size={16} aria-hidden />,
        keywords: ["odswiez", "pobierz", "aktualizuj", "reload"],
        disabled: busy,
        onSelect: onRefresh,
      },
      {
        id: "action-sign-out",
        label: "Wyloguj",
        icon: <LogOut size={16} aria-hidden />,
        keywords: ["wyloguj", "wyjdz", "sesja", "konto"],
        disabled: busy,
        onSelect: onSignOut,
      },
    ];

    return [
      { id: "go", label: "Przejdź do", items: goItems },
      { id: "actions", label: "Działania", items: actionItems },
    ];
  }, [busy, canTrackOwn, canViewTeam, hasActiveEntry, onNavigate, onRefresh, onSignOut, onStart, onStop]);

  const shortcutCategories = useMemo<ShortcutHelpCategory[]>(
    () => [
      {
        category: "Ogólne",
        items: [
          { label: "Paleta poleceń", shortcut: "mod+k" },
          { label: "Skróty klawiszowe", shortcut: "shift+?" },
        ],
      },
      {
        category: "Przejdź do",
        items: [
          { label: "Mój czas", shortcut: "g m" },
          ...(canViewTeam ? [{ label: "Zespół", shortcut: "g z" }] : []),
          { label: "Wygląd", shortcut: "g w" },
        ],
      },
    ],
    [canViewTeam],
  );

  return (
    <AppShell>
      <SidebarShell
        aria-label="Nawigacja TimoTime"
        footer={<SidebarFooter view={view} busy={busy} onSignOut={onSignOut} />}
      >
        <SidebarHeader organizationName={organizationName} personName={personName} />
        <SidebarNav>
          <SidebarLink
            href={VIEW_HASHES["my-time"]}
            icon={<Clock aria-hidden />}
            label="Mój czas"
            active={view === "my-time"}
          />
          {canViewTeam ? (
            <SidebarLink href={VIEW_HASHES.team} icon={<Users aria-hidden />} label="Zespół" active={view === "team"} />
          ) : null}
        </SidebarNav>
      </SidebarShell>

      <Card surface="reading" className="min-w-0 flex-1 overflow-y-auto">
        <main className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
          {actionError ? <Banner tone="danger" message={actionError} onDismiss={onDismissActionError} /> : null}
          {children}
        </main>
      </Card>

      <CommandPalette
        open={palette.open}
        onOpenChange={palette.onOpenChange}
        groups={groups}
        placeholder="Szukaj w TimoTime…"
        emptyText="Nic nie pasuje."
      />
      <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} bindShortcut categories={shortcutCategories} />
    </AppShell>
  );
}

function SidebarHeader({ organizationName, personName }: { organizationName: string; personName: string }) {
  const { collapsed } = useSidebar();
  if (collapsed) {
    return (
      <div className="flex justify-center pt-3 pb-2" title={`TimoTime · ${organizationName} · ${personName}`}>
        <span className="flex size-8 items-center justify-center rounded-xl bg-accent text-accent-fg">
          <Clock className="size-4" aria-hidden />
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2.5 px-3 pt-3 pb-2">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg">
        <Clock className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium tracking-wide text-text-tertiary uppercase">TimoTime</p>
        <p className="truncate text-sm font-semibold text-text-primary">{organizationName}</p>
        <p className="truncate text-xs text-text-secondary">{personName}</p>
      </div>
    </div>
  );
}

function SidebarFooter({ view, busy, onSignOut }: { view: AppView; busy: boolean; onSignOut: () => void }) {
  const { collapsed } = useSidebar();
  return (
    <div className={cn("flex w-full flex-col gap-1", collapsed && "items-center")}>
      <SidebarLink
        href={VIEW_HASHES.appearance}
        icon={<Palette aria-hidden />}
        label="Wygląd"
        active={view === "appearance"}
      />
      <SidebarItem icon={<LogOut aria-hidden />} label="Wyloguj" onClick={onSignOut} disabled={busy} />
      <SidebarCollapseButton />
    </div>
  );
}
