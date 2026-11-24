/**
 * Jedna aplikacja Next.js obsługuje dwa adresy (ADR-0096):
 *
 *   time.monorise.studio       strona produktu i API /api/v1
 *   timo-time.monorise.studio  aplikacja w przeglądarce (ścieżki aplikacji pod /app)
 *
 * Lokalnie: time.localhost:3300 i timo-time.localhost:3300 (przeglądarki kierują *.localhost na 127.0.0.1).
 */
export const DEFAULT_APP_HOSTS = ["timo-time.monorise.studio", "timo-time.localhost"];

export function appHosts(env: string | undefined = process.env.TIMOTIME_APP_HOSTS): string[] {
  return (env ? env.split(",") : DEFAULT_APP_HOSTS).map((host) => host.trim().toLowerCase()).filter(Boolean);
}

/** Nazwa hosta bez portu, małymi literami. */
export function hostname(header: string | null): string {
  const host = (header ?? "").trim().toLowerCase();
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0] ?? "";
}

export type Route = { kind: "next" } | { kind: "rewrite"; pathname: string } | { kind: "not-found" };

/** Co zrobić z żądaniem strony (nie API): przepisać na /app, przepuścić albo odpowiedzieć 404. */
export function routeFor(host: string, pathname: string, hosts: string[] = appHosts()): Route {
  const isAppPath = pathname === "/app" || pathname.startsWith("/app/");
  if (hosts.includes(host)) {
    if (isAppPath) return { kind: "next" };
    return { kind: "rewrite", pathname: `/app${pathname === "/" ? "" : pathname}` };
  }
  // Aplikacja działa tylko pod swoim adresem
  if (isAppPath) return { kind: "not-found" };
  return { kind: "next" };
}
