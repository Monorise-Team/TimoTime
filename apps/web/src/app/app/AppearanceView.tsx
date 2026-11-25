"use client";

import { AppearanceControls } from "@monorise-team/ui";

/** Ustawienia wyglądu z biblioteki (korzystają z ThemeProvider w głównym szkielecie). */
export function AppearanceView() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-text-primary">Wygląd</h1>
        <p className="text-sm text-text-secondary">
          Ustawienia zapisują się w tej przeglądarce i działają od razu w całej aplikacji.
        </p>
      </div>
      <AppearanceControls />
    </div>
  );
}
