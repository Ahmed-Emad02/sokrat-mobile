# Sokrat VOICE — Mobile Push-to-Wake

This directory adds a **zero-background / push-to-wake mobile client** for the
existing Sokrat web softphone. Traditional SIP clients die in the background on
iOS 13+/Android 10+; this solution keeps incoming calls ringing natively by
forwarding the call to Apple APNs / Google FCM, which wake the app from a cold
kill on a fresh WebSocket to Asterisk.

```
Asterisk PBX ──▶ sokrat-push-gateway ──▶ APNs / FCM ──▶ Mobile app wakes
 (incoming)     (maps ext→device tokens)                 Native CallKit/Telecom
                                                              │
Asterisk ◀══ WebRTC audio ──(app registers over WSS)──────────┘
```

## What was added

| Path | What it is |
|------|-----------|
| `sokrat-mobile/` | React Native app (RN 0.87) — sip.js + native WebRTC/CallKit |

The **push gateway is a separate repository**: <https://github.com/Ahmed-Emad02/sokrat-push-gateway>
(Node/Express APNs+FCM service + `mobile_devices` table). The `sokrat-voip-dev`
installer clones and installs it by default.

---

## 1. Push Gateway (back end)

Separate repo → <https://github.com/Ahmed-Emad02/sokrat-push-gateway>

```bash
git clone https://github.com/Ahmed-Emad02/sokrat-push-gateway /opt/sokrat-push-gateway
cd /opt/sokrat-push-gateway
cp .env.example .env          # set DB creds + APNs/FCM keys
npm install
node src/index.js             # listens on :8095
```

Endpoints:
- `POST /api/push/register-device` — mobile app binds a device token to an extension.
- `POST /api/push/remove-device` — logout.
- `GET /api/push/incoming-call?callee=150&caller=...&callerName=...` — Asterisk fires this.
- `GET /health` — liveness + provider status.

### DB table
```sql
source sql/mobile_devices.sql
```

### Asterisk dialplan
Add to `/etc/asterisk/extensions_custom.conf` and call the macro before bridging
an incoming call to a mobile extension (see the commented examples in
`sokrat-push-gateway/asterisk/extensions_custom.conf`). It `curl`s the gateway
in a backgrounded shell with a 1s timeout so it never blocks the PBX.

### Push credentials (you must still obtain these)
- **iOS**: Apple Developer account → a **VoIP Services** `.p8` key (PushKit entitlement must be in the app).
- **Android**: Firebase project → service-account JSON; set `FCM_ENABLED=true`.

---

## 2. React Native app (`sokrat-mobile`)

```bash
cd sokrat-mobile
npm install
npx react-native run-android     # Android build (see notes below)
```

### Stack
- `sip.js` (successor to JsSIP) for WebSocket SIP signaling, shimmed onto
  `react-native-webrtc`'s native libwebrtc for media.
- `react-native-callkeep` → CallKit (iOS) / TelecomManager ConnectionService (Android).
- `react-native-voip-push-notification` → iOS PushKit.
- `react-native-incall-manager` → proximity sensor + audio routing.
- `@react-native-community/push-notification-ios` → iOS notification permissions.

### Source layout
```
src/
  config.ts      PBX host, WSS URL, push-gateway URL
  sip/sipService.ts      SIP register + call lifecycle (mirrors web softphone-core.js)
  push/pushHandler.ts    PushKit/FCM cold-start wake + token registration
  calls/callKit.ts       native incoming-call screen
  calls/incall.ts        audio routing / proximity
  ui/LoginScreen.tsx     sign-in (extension + password)
  ui/RingingScreen.tsx   in-app ringing overlay
  theme.ts               Sokrat dark palette (JetBrains Mono identity)
```

---

## Remaining setup before a working build

1. **Android FCM package**: the Android push path references
   `@react-native-firebase/app` + `@react-native-firebase/messaging`. Install
   them and run the Android Firebase setup **before** the final Android build:
   ```bash
   npm i @react-native-firebase/app @react-native-firebase/messaging
   ```
   (Code already `require`s `@react-native-firebase/messaging` only on Android.)

2. **iOS**: this machine is Windows, so run `pod install` inside `sokrat-mobile/ios`
   on a Mac, enable the **Push Notifications** + **VoIP Background Mode**
   capabilities, and wire the PushKit entitlement.

3. **Secure credential storage**: `App.tsx` currently passes the SIP password in
   memory; swap in your secure-store (e.g. `react-native-keychain`) and persist the
   last extension + push tokens via AsyncStorage between cold starts.

4. **First Android build** downloads Gradle + SDK build-tools 37 + WebRTC's NDK
   (several GB). Run it once on the target machine with `--info` on a Long-Running
   connection.

## Tests
```bash
cd sokrat-mobile && npm test   # Jest (native VoIP modules mocked)
```
