import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Nie ma takiej strony · TimoTime" };

export default function GlobalNotFound() {
  return (
    <html lang="pl" className="dark" data-theme="moonlight">
      <body className="flex min-h-dvh items-center justify-center p-6">
        <div className="mr-backdrop" aria-hidden />
        <main className="mr-float mr-enter flex max-w-sm flex-col gap-3 rounded-card p-8 text-center">
          <p className="text-sm text-text-tertiary">404</p>
          <h1 className="font-display text-xl font-semibold">Nie ma takiej strony</h1>
          <a href="/" className="text-sm text-link hover:underline">
            Wróć na stronę główną
          </a>
        </main>
      </body>
    </html>
  );
}
