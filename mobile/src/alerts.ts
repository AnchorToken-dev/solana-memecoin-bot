/**
 * Capacitor Local Notifications for paper session events.
 * Polls GET /alerts?since= and fires when Session alerts toggle is on.
 */
import { LocalNotifications } from "@capacitor/local-notifications";
import { Preferences } from "@capacitor/preferences";
import { api } from "./api";

const ENABLED_KEY = "sessionAlertsEnabled";
const SINCE_KEY = "sessionAlertsSince";
const PERMISSION_ASKED_KEY = "sessionAlertsPermissionAsked";

let notifId = 1;
let polling = false;

export async function getSessionAlertsEnabled(): Promise<boolean> {
  try {
    const { value } = await Preferences.get({ key: ENABLED_KEY });
    if (value === "0" || value === "false") return false;
    if (value === "1" || value === "true") return true;
  } catch {
    /* fall through */
  }
  const ls = localStorage.getItem(ENABLED_KEY);
  if (ls === "0" || ls === "false") return false;
  return true; // default ON
}

export async function setSessionAlertsEnabled(on: boolean): Promise<void> {
  const v = on ? "1" : "0";
  try {
    await Preferences.set({ key: ENABLED_KEY, value: v });
  } catch {
    /* browser */
  }
  localStorage.setItem(ENABLED_KEY, v);
}

async function getSince(): Promise<number> {
  try {
    const { value } = await Preferences.get({ key: SINCE_KEY });
    if (value) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
  } catch {
    /* */
  }
  const ls = localStorage.getItem(SINCE_KEY);
  if (ls) {
    const n = Number(ls);
    if (Number.isFinite(n)) return n;
  }
  return Date.now(); // start from now — avoid flood of old events
}

async function setSince(ts: number): Promise<void> {
  const v = String(ts);
  try {
    await Preferences.set({ key: SINCE_KEY, value: v });
  } catch {
    /* */
  }
  localStorage.setItem(SINCE_KEY, v);
}

export async function ensureAlertPermission(): Promise<boolean> {
  try {
    const check = await LocalNotifications.checkPermissions();
    if (check.display === "granted") return true;
    const req = await LocalNotifications.requestPermissions();
    try {
      await Preferences.set({ key: PERMISSION_ASKED_KEY, value: "1" });
    } catch {
      localStorage.setItem(PERMISSION_ASKED_KEY, "1");
    }
    return req.display === "granted";
  } catch {
    // Browser preview — no native plugin; treat as granted for soft toast only
    return false;
  }
}

async function fireLocal(title: string, body: string): Promise<void> {
  notifId = (notifId % 100000) + 1;
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: notifId,
          title,
          body,
          schedule: { at: new Date(Date.now() + 250) },
          smallIcon: "ic_stat_icon_default",
          largeIcon: "ic_launcher",
        },
      ],
    });
  } catch (err) {
    console.warn("Local notification failed", err);
  }
}

/**
 * Poll /alerts and notify. Safe to call from the 8s UI interval.
 */
export async function pollSessionAlerts(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const enabled = await getSessionAlertsEnabled();
    if (!enabled) return;
    const since = await getSince();
    const { events } = await api.alerts(since, 30);
    if (!events.length) return;
    const granted = await ensureAlertPermission();
    let maxTs = since;
    for (const ev of events) {
      if (ev.timestamp > maxTs) maxTs = ev.timestamp;
      if (granted) {
        await fireLocal(ev.title, ev.body);
      }
    }
    await setSince(maxTs);
  } catch {
    // API down — ignore
  } finally {
    polling = false;
  }
}

/** Call once when user taps Start so we can request permission early. */
export async function onStartRequestAlerts(): Promise<void> {
  const enabled = await getSessionAlertsEnabled();
  if (!enabled) return;
  await ensureAlertPermission();
  // Advance since so we don't miss the bot_started event — leave a small skew
  const since = await getSince();
  if (since > Date.now() - 1000) {
    await setSince(Date.now() - 2000);
  }
}
