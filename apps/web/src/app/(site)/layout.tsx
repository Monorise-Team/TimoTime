import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "../globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.TIMOTIME_API_URL ?? "https://time.monorise.studio"),
  title: "TimoTime: ewidencja czasu pracy w przeglądarce i na telefonie",
  description:
    "TimoTime rejestruje czas pracy, przerwy, pracę zdalną i wyjścia służbowe w przeglądarce i na telefonie, z logowaniem kontem Monorise.",
  alternates: { canonical: "/" },
};

export const viewport: Viewport = { themeColor: "#071826", colorScheme: "dark" };

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pl" className="dark" data-theme="moonlight">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
