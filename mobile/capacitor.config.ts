import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.anchortoken.memecoinbot",
  appName: "Memecoin Paper Bot",
  webDir: "dist",
  server: {
    // Cleartext HTTP allowed so phone can hit laptop LAN API in paper/dev.
    cleartext: true,
    androidScheme: "https",
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
