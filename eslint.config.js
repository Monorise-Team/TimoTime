import { monorise } from "@monorise-team/config/eslint";

// Pliki w katalogu głównym (skrypty, konfiguracje); aplikacje i paczki mają własne eslint.config.js.
export default monorise({ ignores: ["apps/**", "packages/**"], tsconfigRootDir: import.meta.dirname });
