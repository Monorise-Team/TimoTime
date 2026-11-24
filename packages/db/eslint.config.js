import { monorise } from "@monorise-team/config/eslint";

export default monorise({ ignores: ["src/generated/**"], tsconfigRootDir: import.meta.dirname });
