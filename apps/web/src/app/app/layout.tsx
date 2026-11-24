import { appearanceInitScript } from "@monorise-team/ui";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "../globals.css";

export const metadata: Metadata = {
  title: "TimoTime",
  description: "Ewidencja czasu pracy TimoTime w przeglądarce.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { colorScheme: "dark light" };

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pl" className="dark" data-theme="mono" suppressHydrationWarning>
      <head>
        {/* Zapisany tryb i motyw przed pierwszym malowaniem, bez mignięcia */}
        <script dangerouslySetInnerHTML={{ __html: appearanceInitScript }} />
      </head>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
