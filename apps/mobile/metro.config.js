// Metro w przestrzeni roboczej pnpm: Expo sam rozpoznaje monorepo (paczki z ../../packages).
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
