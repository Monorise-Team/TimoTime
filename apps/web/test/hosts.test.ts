import { describe, expect, it } from "vitest";
import { appHosts, hostname, routeFor } from "@/lib/hosts";

const HOSTS = appHosts(undefined);

describe("dwa adresy z jednej aplikacji", () => {
  it("timo-time. pokazuje aplikację: ścieżki przepisuje na /app", () => {
    expect(routeFor("timo-time.monorise.studio", "/", HOSTS)).toEqual({ kind: "rewrite", pathname: "/app" });
    expect(routeFor("timo-time.localhost", "/entries", HOSTS)).toEqual({ kind: "rewrite", pathname: "/app/entries" });
  });

  it("time. pokazuje stronę produktu, a ścieżki /app dają tam 404", () => {
    expect(routeFor("time.monorise.studio", "/", HOSTS)).toEqual({ kind: "next" });
    expect(routeFor("time.monorise.studio", "/app", HOSTS)).toEqual({ kind: "not-found" });
    expect(routeFor("localhost", "/app/entries", HOSTS)).toEqual({ kind: "not-found" });
  });

  it("czyta nazwę hosta bez portu", () => {
    expect(hostname("Timo-Time.localhost:3300")).toBe("timo-time.localhost");
    expect(hostname(null)).toBe("");
  });

  it("lista adresów aplikacji z TIMOTIME_APP_HOSTS", () => {
    expect(appHosts("czas.example.test, App.Example.test")).toEqual(["czas.example.test", "app.example.test"]);
  });
});
