# AGENTS.md

Guidance and operational gotchas for AI agents working in `sokrat-mobile-main`
(`~/suite/mobile` in WSL, `G:\suite\apps\sokrat-mobile-main` on Windows).

> Environment map for all five repos / ports / WSL-VM-Windows access:
> [`../../ACCESS.md`](../../ACCESS.md) — this is the **Windows-side** target (§6).

---

## 1. Stack

- **React Native 0.87.1**, React **19.2.3**, CLI 20.2.0, TypeScript, Jest.
- `engines.node: ">= 22.11.0"` — older Node will refuse to install.
- Telephony-heavy deps: `react-native-webrtc`, `jssip`, `sip.js`,
  `react-native-callkeep`, `react-native-in-call-manager`,
  `@react-native-firebase/messaging`, `react-native-voip-push-notification`.
- Push: `firebase.json` + `MOBILE-PUSH.md`.
- Native: `android/`, `ios/` (`.bundle/` → Cocoaapods), `patches/`.

```
sokrat-mobile-main/
├── src/                  # app code
├── __tests__/App.test.tsx
├── android/  ios/
├── patches/react-native-callkeep+4.3.16.patch
├── compile-softphone.js  # ← runs on postinstall (§4)
├── metro.config.js  jest.config.js  babel.config.js  tsconfig.json
└── MOBILE-PUSH.md
```

---

## 2. Where it runs

| Piece | Where | Notes |
| --- | --- | --- |
| Metro dev server | **WSL** | `npx react-native start --port 8082` |
| Android build + emulator/device | **Windows** | needs Android SDK + `adb`; driven from WSL via interop |
| iOS build | **impossible on this machine** | Windows/WSL only — do not attempt `run-ios` |

From WSL, drive the Windows side:

```bash
adb.exe devices
adb.exe reverse tcp:8081 tcp:8082     # app expects :8081 on-device → Metro on host :8082
cmd.exe /c gradlew.bat assembleDebug  # Windows-side Gradle build
```

---

## 3. Commands

```bash
npm ci                    # NOT --ignore-scripts, see §4
npx react-native start --port 8082     # Metro  ⚠️ 8081 collides with the CRM
npm run android           # react-native run-android
npm test                  # jest  (tests/__tests__/App.test.tsx)
npm run lint              # eslint .
```

---

## 4. Gotchas

- **`postinstall` is load-bearing:** `"patch-package && node compile-softphone.js"`.
  Running `npm ci --ignore-scripts` (a common "fix the install" reflex) skips both →
  `react-native-callkeep` patch not applied and the softphone **silently not compiled**.
  Always install with scripts enabled.
- **Do not bump `react-native-callkeep`** — `patches/…+4.3.16.patch` is version-pinned.
  Re-diff and regenerate the patch if you do.
- **Node >= 22.11** is required by `engines`.
- **Metro 8081 ↔ CRM 8081.** Use `--port 8082` here. See `../../ACCESS.md` §3.
- **No `.env.example`.** Config lives in `app.json` / `src/` and `firebase.json`.
- **JDK:** this machine has Adoptium **JDK 25**; React Native 0.87 / AGP expect
  **JDK 17**. Set `JAVA_HOME` accordingly or the Gradle build will fail.
- **No `adb` on Windows yet** — install Android SDK platform-tools first
  (`../../ACCESS.md` §6).

---

## 5. Testing

```bash
npm test        # Jest → __tests__/App.test.tsx
npm run lint    # eslint
```

Native-side tests live in `android/` / `ios/` (JUnit/XCTest) — run those on the
platform toolchain, not from WSL.

---

## 6. Relationship to the rest of the suite

- Talks to the **softphone** (`sokrat-voice-main`, `:8090`) and the
  **push-to-wake gateway** (`sokrat-push-gateway-master`, `:8095`) over SIP/WebSocket.
- Registers device tokens via `POST /api/push/register-device`.
- Build and test against the Rocky VM (`ssh rocky`) for end-to-end call flows —
  see `../../ACCESS.md` §5.

---

## 7. Non-Interference Invariants with Desktop SIP (MicroSIP / Zoiper)

- **Production Invariant**: Existing users rely primarily on desktop clients (**MicroSIP, Zoiper**) and IP desk phones. The mobile app must operate without disrupting desktop routing or audio fidelity.
- **WebRTC Scope**: WebRTC endpoints (`pjsip_custom.conf`) are dedicated strictly to Sokrat Mobile and Sokrat CRM embedded softphones. Standard users remain on standard SIP.
- **Client-Side DSP**: All audio processing (noise suppression, highpass filter, gain calibration) belongs in `src/sip/JsSipService.ts`. Never inject PBX-level dialplan hacks, volume multipliers, or early-media overrides into Asterisk that could alter desktop behavior.
- **No PBX Dialplan Hijacking**: Never place wildcard dial patterns into `[from-internal-custom]` on the PBX server. Outbound routing must go through standard FreePBX trunk macros.
