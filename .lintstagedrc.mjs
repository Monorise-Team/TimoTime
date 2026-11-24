/** Przed każdym commitem: ESLint i Prettier tylko na zmienionych plikach (typy całości sprawdza hook osobno). */
export default {
  "*.{ts,tsx,js,mjs,cjs}": ["eslint --max-warnings=0 --fix --no-warn-ignored", "prettier --write --ignore-unknown"],
  "*.{json,jsonc,md,yml,yaml,css,html}": "prettier --write --ignore-unknown",
};
