import { monorise } from "@monorise-team/config/eslint";

export default monorise({
  react: true,
  ignores: ["dist/**", ".expo/**", "metro.config.js"],
  tsconfigRootDir: import.meta.dirname,
});
