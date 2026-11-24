import type { AppTokens, TokenStore } from "@timotime/client";
import * as SecureStore from "expo-secure-store";

/** Tokeny z Core w systemowym sejfie telefonu (Keychain na iOS, Keystore na Androidzie), ADR-0050. */
const KEY = "timotime-mobile-tokens";

export const secureStore: TokenStore = {
  async read() {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AppTokens;
    } catch {
      return null;
    }
  },
  async write(tokens) {
    if (tokens) await SecureStore.setItemAsync(KEY, JSON.stringify(tokens));
    else await SecureStore.deleteItemAsync(KEY);
  },
};
