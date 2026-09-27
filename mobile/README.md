# Mobile control UI (Capacitor)

Android APK shell for Mark’s paper Solana memecoin bot.

- **Engine stays on the laptop** (`npm run api` in repo root).
- **Phone = control UI only** — status, start/stop paper runner, bankroll/PnL, trades, API URL.
- **No private keys / no wallet** in the app. Live trading is stubbed server-side.

See the root [README](../README.md) § **Android APK** for Linux build (`./gradlew assembleDebug`) and how the phone reaches the API (`adb reverse` or LAN IP).

```bash
npm install
npm run build
npx cap sync android
cd android && ./gradlew assembleDebug
```
