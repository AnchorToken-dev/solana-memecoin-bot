import { Preferences } from "@capacitor/preferences";

const KEY = "apiBaseUrl";
/** Emulator / adb reverse default — laptop API on port 8787. */
export const DEFAULT_API_BASE = "http://127.0.0.1:8787";

export async function getApiBaseUrl(): Promise<string> {
  try {
    const { value } = await Preferences.get({ key: KEY });
    if (value && value.trim()) return value.trim().replace(/\/$/, "");
  } catch {
    // Browser preview without Capacitor bridge — fall through to localStorage
  }
  const ls = localStorage.getItem(KEY);
  if (ls && ls.trim()) return ls.trim().replace(/\/$/, "");
  return DEFAULT_API_BASE;
}

export async function setApiBaseUrl(url: string): Promise<void> {
  const cleaned = url.trim().replace(/\/$/, "");
  try {
    await Preferences.set({ key: KEY, value: cleaned });
  } catch {
    /* native prefs unavailable in plain browser */
  }
  localStorage.setItem(KEY, cleaned);
}
