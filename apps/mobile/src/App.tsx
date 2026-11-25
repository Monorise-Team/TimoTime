import { createCoreClient, type Me as CoreMe } from "@monorise-team/sdk";
import {
  ApiError,
  createAppSession,
  createClient,
  TIME_ENTRY_KIND_LABELS,
  type TimeEntry,
  type TimeEntryKind,
} from "@timotime/client";
import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { CORE_API, mobileSignIn } from "./auth";
import { secureStore } from "./session";
import { colors, gap, radius } from "./theme";

/** Aktualny czas do licznika. Wołane w obsłudze zdarzeń i w efektach, nigdy w renderze. */
function readClock(): number {
  return Date.now();
}

const apiUrl = (Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? "http://127.0.0.1:3300";

const STATUS_ACTIONS: { kind: TimeEntryKind; label: string }[] = [
  { kind: "WORK", label: "Rozpocznij pracę" },
  { kind: "BREAK", label: "Przerwa" },
  { kind: "REMOTE", label: "Praca zdalna" },
  { kind: "BUSINESS_TRIP", label: "Wyjście służbowe" },
];

const formatDuration = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} godz. ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${seconds} sek.`;
};

const formatClock = (iso: string): string => {
  const date = new Date(iso);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
};

const localDayBounds = (nowMs: number) => {
  const now = new Date(nowMs);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const nextStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return {
    startMs: start.getTime(),
    nextStartMs: nextStart.getTime(),
    from: start.toISOString(),
    to: end.toISOString(),
  };
};

/** Część czasu trwania wpisu przypadająca na podany lokalny dzień (podział o północy). */
const durationWithinDayMs = (entry: TimeEntry, nowMs: number, dayStartMs: number, nextDayStartMs: number): number => {
  const start = Math.max(new Date(entry.startedAt).getTime(), dayStartMs);
  const end = Math.min(entry.endedAt ? new Date(entry.endedAt).getTime() : nowMs, nextDayStartMs);
  return Math.max(0, end - start);
};

const formatError = (error: unknown) =>
  error instanceof ApiError ? error.message : "Brak połączenia z serwerem TimoTime. Sprawdź adres i sieć.";

const isAccessDeniedError = (error: unknown): error is ApiError =>
  error instanceof ApiError &&
  (error.code === "PRODUCT_ACCESS_REQUIRED" || error.code === "PERMISSION_DENIED" || error.status === 403);

const profileHeader = (me: CoreMe): string => {
  const fullName = `${me.employee.firstName} ${me.employee.lastName}`.trim() || me.account.email;
  return `${fullName} · ${me.organization.name}`;
};

/**
 * TimoTime na telefonie: logowanie kontem Monorise (PKCE), profil bezpośrednio z Core API (`@monorise-team/sdk`),
 * bieżący status, przyciski start/przerwa/stop i lista dzisiejszych wpisów.
 */
export function App() {
  const session = useMemo(() => createAppSession(mobileSignIn, secureStore), []);
  const client = useMemo(() => createClient({ baseUrl: apiUrl, getToken: () => session.accessToken() }), [session]);
  const coreClient = useMemo(
    () => createCoreClient({ baseUrl: CORE_API, getAccessToken: () => session.accessToken(CORE_API) }),
    [session],
  );
  const [signedIn, setSignedIn] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    void session.isSignedIn().then(setSignedIn);
    return session.subscribe(setSignedIn);
  }, [session]);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={styles.root}>
        {signedIn === undefined ? (
          <Centered>
            <ActivityIndicator color={colors.accent} />
          </Centered>
        ) : signedIn ? (
          <Tracker client={client} coreClient={coreClient} onSignOut={() => void session.signOut()} />
        ) : (
          <SignIn onSignIn={session.signIn} />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

function SignIn({ onSignIn }: { onSignIn: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await onSignIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się zalogować.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.card, styles.signIn]}>
      <Text style={styles.title}>Zaloguj się do TimoTime</Text>
      <Text style={styles.muted}>Logujesz się kontem Monorise, tym samym co w przeglądarce.</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        style={[styles.primary, busy ? styles.disabled : null]}
        onPress={() => void start()}
        disabled={busy}
        accessibilityRole="button"
      >
        <Text style={styles.primaryText}>{busy ? "Logowanie…" : "Zaloguj się kontem Monorise"}</Text>
      </Pressable>
    </View>
  );
}

function Tracker({
  client,
  coreClient,
  onSignOut,
}: {
  client: ReturnType<typeof createClient>;
  coreClient: ReturnType<typeof createCoreClient>;
  onSignOut: () => void;
}) {
  const [me, setMe] = useState<CoreMe | null>(null);
  const [current, setCurrent] = useState<TimeEntry | null>(null);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accessDeniedMessage, setAccessDeniedMessage] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const fetchTrackerData = useCallback(async () => {
    const { from, to } = localDayBounds(readClock());
    const [active, list] = await Promise.all([client.time.current(), client.time.entries({ from, to })]);
    return { active, entries: list.entries };
  }, [client]);

  const load = useCallback(async () => {
    setError(null);
    setAccessDeniedMessage(null);
    try {
      const data = await fetchTrackerData();
      setCurrent(data.active);
      setEntries(data.entries);
      setNowMs(readClock());
    } catch (e) {
      if (isAccessDeniedError(e)) {
        setAccessDeniedMessage(e.message);
      } else {
        setError(formatError(e));
      }
    } finally {
      setLoading(false);
    }
  }, [fetchTrackerData]);

  useEffect(() => {
    let cancelled = false;
    void coreClient
      .getMe()
      .then((profile) => {
        if (!cancelled) setMe(profile);
      })
      .catch(() => null);

    fetchTrackerData().then(
      (data) => {
        if (cancelled) return;
        setCurrent(data.active);
        setEntries(data.entries);
        setAccessDeniedMessage(null);
        setNowMs(readClock());
        setLoading(false);
      },
      (e: unknown) => {
        if (cancelled) return;
        if (isAccessDeniedError(e)) {
          setAccessDeniedMessage(e.message);
        } else {
          setError(formatError(e));
        }
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [coreClient, fetchTrackerData]);

  useEffect(() => {
    if (!current) return;
    const id = setInterval(() => setNowMs(readClock()), 1000);
    return () => clearInterval(id);
  }, [current]);

  async function startKind(kind: TimeEntryKind) {
    setBusy(true);
    setError(null);
    try {
      await client.time.start({ kind });
      setNowMs(readClock());
      await load();
    } catch (e) {
      if (isAccessDeniedError(e)) {
        setAccessDeniedMessage(e.message);
      } else {
        setError(formatError(e));
      }
    } finally {
      setBusy(false);
    }
  }

  async function stopEntry() {
    setBusy(true);
    setError(null);
    try {
      await client.time.stop();
      setNowMs(readClock());
      await load();
    } catch (e) {
      if (isAccessDeniedError(e)) {
        setAccessDeniedMessage(e.message);
      } else {
        setError(formatError(e));
      }
    } finally {
      setBusy(false);
    }
  }

  const { startMs: dayStartMs, nextStartMs: nextDayStartMs } = localDayBounds(nowMs);
  const todayWorkMs = entries.reduce((sum, entry) => {
    if (entry.kind === "BREAK") return sum;
    return sum + durationWithinDayMs(entry, nowMs, dayStartMs, nextDayStartMs);
  }, 0);

  return (
    <View style={styles.fill}>
      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>TIMOTIME</Text>
          {me ? <Text style={styles.muted}>{profileHeader(me)}</Text> : null}
        </View>
        <Pressable onPress={onSignOut} accessibilityRole="button">
          <Text style={styles.muted}>Wyloguj</Text>
        </Pressable>
      </View>

      {loading ? (
        <Centered>
          <ActivityIndicator color={colors.accent} />
        </Centered>
      ) : accessDeniedMessage ? (
        <View style={[styles.card, styles.accessDenied]}>
          <Text style={styles.title}>Brak dostępu do TimoTime</Text>
          <Text style={styles.muted}>{accessDeniedMessage}</Text>
          <Pressable
            style={styles.primary}
            onPress={() => {
              setLoading(true);
              void load();
            }}
            accessibilityRole="button"
          >
            <Text style={styles.primaryText}>Spróbuj ponownie</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <View style={styles.section}>
              <View style={[styles.card, styles.statusCard]}>
                <Text style={styles.muted}>Bieżący status</Text>
                <Text style={styles.title}>{current ? TIME_ENTRY_KIND_LABELS[current.kind] : "Poza pracą"}</Text>
                {current ? (
                  <Text style={styles.muted}>
                    Od {formatClock(current.startedAt)} ({formatDuration(nowMs - new Date(current.startedAt).getTime())}
                    )
                  </Text>
                ) : null}
                <View style={styles.actions}>
                  {STATUS_ACTIONS.map((action) => {
                    const active = current?.kind === action.kind;
                    return (
                      <Pressable
                        key={action.kind}
                        style={[
                          styles.actionButton,
                          active ? styles.actionButtonActive : null,
                          busy ? styles.disabled : null,
                        ]}
                        onPress={() => void startKind(action.kind)}
                        disabled={busy}
                        accessibilityRole="button"
                      >
                        <Text style={active ? styles.primaryText : styles.actionText}>{action.label}</Text>
                      </Pressable>
                    );
                  })}
                  <Pressable
                    style={[styles.stopButton, busy || !current ? styles.disabled : null]}
                    onPress={() => void stopEntry()}
                    disabled={busy || !current}
                    accessibilityRole="button"
                  >
                    <Text style={styles.stopText}>Zakończ</Text>
                  </Pressable>
                </View>
                {error ? <Text style={styles.error}>{error}</Text> : null}
              </View>

              <View style={styles.summaryRow}>
                <Text style={styles.sectionTitle}>Dzisiaj</Text>
                <Text style={styles.muted}>Suma pracy: {formatDuration(todayWorkMs)}</Text>
              </View>
            </View>
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.muted}>Brak wpisów z dzisiaj.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const startedBeforeToday = new Date(item.startedAt).getTime() < dayStartMs;
            const duration = durationWithinDayMs(item, nowMs, dayStartMs, nextDayStartMs);
            return (
              <View style={[styles.row, styles.rowInline]}>
                <View>
                  <Text style={styles.rowTitle}>{TIME_ENTRY_KIND_LABELS[item.kind]}</Text>
                  <Text style={styles.muted}>
                    {startedBeforeToday ? "00:00" : formatClock(item.startedAt)} do{" "}
                    {item.endedAt ? formatClock(item.endedAt) : "teraz"}
                  </Text>
                </View>
                <Text style={styles.rowTitle}>{formatDuration(duration)}</Text>
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#09090b" },
  fill: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 24 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  brand: { color: colors["text-secondary"], fontSize: 12, fontWeight: "600", letterSpacing: 1.5 },
  card: {
    backgroundColor: colors["bg-secondary"],
    borderColor: colors["card-border"],
    borderWidth: 1,
    borderRadius: radius.card,
  },
  signIn: { margin: 16, marginTop: 80, padding: 20, gap: 12 },
  accessDenied: { margin: 16, marginTop: 32, padding: 20, gap: 12 },
  statusCard: { padding: 16, gap: 8 },
  section: { gap: 12, marginBottom: 8 },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 4 },
  sectionTitle: { color: colors["text-primary"], fontSize: 16, fontWeight: "600" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  actionButton: {
    backgroundColor: colors["bg-tertiary"],
    borderRadius: radius.control,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  actionButtonActive: { backgroundColor: colors.accent },
  actionText: { color: colors["text-primary"], fontSize: 14, fontWeight: "500" },
  stopButton: {
    backgroundColor: colors.danger,
    borderRadius: radius.control,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  stopText: { color: "#ffffff", fontSize: 14, fontWeight: "600" },
  disabled: { opacity: 0.45 },
  list: { padding: gap, gap: 8 },
  row: {
    backgroundColor: colors["bg-secondary"],
    borderRadius: radius.row,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 2,
  },
  rowInline: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowTitle: { color: colors["text-primary"], fontSize: 15, fontWeight: "500" },
  title: { color: colors["text-primary"], fontSize: 20, fontWeight: "600" },
  muted: { color: colors["text-tertiary"], fontSize: 13 },
  error: { color: colors.danger, fontSize: 14 },
  empty: { paddingVertical: 24, alignItems: "center" },
  primary: { backgroundColor: colors.accent, borderRadius: 999, paddingVertical: 12, alignItems: "center" },
  primaryText: { color: colors["accent-fg"], fontSize: 14, fontWeight: "600" },
});
