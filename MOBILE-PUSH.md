# Sokrat VOICE — Mobile Push-to-Wake

This is the **mobile repository root** (RN 0.87). Android incoming calls are owned
by native Kotlin; JS only persists/deduplicates the canonical call, bootstraps
SIP, and registers the device token.

```
Asterisk PBX ──▶ sokrat-push-gateway ──▶ FCM ──▶ SokratFirebaseMessagingService
 (incoming)     (tenant/device approval)          │ native notification/action
                                                  ▼
                                     headless JS / mounted App.tsx
                                                  │
Asterisk ◀══ WebRTC audio ──(app registers over WSS)──────────┘
```

The push gateway is a **separate repository**
(<https://github.com/Ahmed-Emad02/sokrat-push-gateway>). Android requires
`@react-native-firebase/app` + `@react-native-firebase/messaging`; both are
already dependency-managed by this app. `android/app/google-services.json` must
match the Firebase project/package (`com.sokratmobile`).

---

## 1. Android push components

| Path | Responsibility |
|------|----------------|
| `android/.../SokratFirebaseMessagingService.kt` | Single FCM entry; validates UUID/extension/timestamp; persists the call, presents the native notification, forwards headless JS. |
| `android/.../IncomingCallStore.kt` | Durable pre-INVITE records/actions, 90 s record lifetime, 120 s terminal tombstones, active-extension ownership. |
| `android/.../IncomingCallNotificationHelper.kt` | Full-screen/CallStyle notification, per-call dismissal, 90 s remaining-age timeout, idempotent presentation. |
| `android/.../CallNotificationModule.kt` | Native action bridge, pending-action replay, notification availability, owner binding, volume/routing facade. |
| `android/.../IncomingPushPolicy.kt` | Pure ingress/action policy used by native and JVM tests. |
| `src/push/pushHandler.ts` | FCM background/foreground handling, pending/cancel persistence, token registration, headless SIP bootstrap. |
| `App.tsx` | Canonical call ownership, Answer/Decline/End, first-push ownership, timeout cleanup, native action handling. |

RNFirebase's `ReactNativeFirebaseMessagingService` is removed in the manifest;
its `ReactNativeFirebaseMessagingReceiver` remains as the one-way headless-JS
target. `SokratFirebaseMessagingService.onNewToken()` retains the RNFirebase
token-refresh emitter.

---

## 2. Push data contract

Android call pushes are **data-only** high-priority messages. All values are
strings.

Incoming:
```json
{
  "msg": "incoming-call",
  "type": "incoming-call",
  "callId": "<tenant-scoped UUID>",
  "callerId": "150",
  "callerName": "display metadata",
  "extension": "102",
  "timestamp": "<epoch milliseconds>",
  "sipWss": ""
}
```

Cancel:
```json
{ "msg": "cancel-call", "type": "cancel-call", "callId": "<same UUID>",
  "extension": "102", "timestamp": "<epoch milliseconds>" }
```

- The gateway's Android TTL is **15 000 ms for incoming** and **120 000 ms for
  cancel** (`android.ttl` is milliseconds with firebase-admin 14.x).
- `callId` must be an RFC 4122 UUID generated/scoped identically to the SIP
  `X-Sokrat-Call-ID` header. Correlation is **strict**: an Answer/Decline/End
  action is applied only to the matching canonical call id. There is no
  same-caller fallback or different-id adoption.
- `extension` binds the call to the active account. A blank/mismatched extension
  is rejected while an owner is persisted.
- `timestamp` is the gateway dispatch time. Missing/invalid or more than 15 s old
  is rejected; more than 5 s in the future is rejected as a clock-skew error.
  Cancels are target-scoped and are not age-rejected.
- Provider TTL is only a backstop: FCM can still deliver a duplicate within the
  TTL. Native checks for an existing live record **before** applying the ingress
  guard; a stale duplicate is ignored and must never dismiss or terminalize a
  live call.

---

## 3. Ages and ownership

- Provider ingress freshness: **15 s** from dispatch (`IncomingPushPolicy` and
  `pushHandler.normalizeIncomingPayload`).
- Accepted native record/UI/JS pending lifetime: **90 s** anchored to the
  existing dispatch timestamp. The notification timeout uses the remaining part
  of that 90 s budget, so an action at 20 s remains valid for a call accepted at
  14 s.
- Terminal/cancel tombstones: **120 s** native and JS. A late cancel is still
  processed to clear state; tombstones suppress retries, not cancellation.
- First push owns the single incoming overlay. A second push/native action for a
  different call id is rejected and dismissed per-call; it never replaces the
  first overlay. One call id may be answered at a time.
- An active/held call is not terminalized or hung up by a late `cancel-call`.
  The ongoing End action remains usable. Late end events for an older call do
  not erase a newer call's pending Answer/End or watchdog.
- A native action with `action=null` is never replayed. SHOW/ANSWER/DECLINE
  intents cannot recreate a removed/expired record; only an END action may
  address an already-owned call without a record.

### Account binding limitation

Native ownership is keyed by **extension** (persisted before token registration
and cleared on logout/switch). The FCM payload carries no PBX/tenant id, so two
PBXs that use the same extension number cannot be distinguished by this layer.
Full tenant/PBX namespace protection requires a coordinated tenant identifier in
the push contract and persisted account; do not claim it from this build.

---

## 4. Notification behavior

- Channels: `sokrat_incoming_calls_v3` (high importance), `sokrat_active_call_v3`,
  `sokrat_missed_calls_v1`, `sokrat_connection_v1`.
- CallStyle/answer/decline actions are used on Android 12+; a non-CallStyle
  fallback handles Android 14 CallStyle rejection (no foreground-service
  requirement).
- Full-screen intent is used only when `canUseFullScreenIntent()` allows it.
  Users are prompted/bannered when full-screen intent access, notification
  permission, the incoming channel, or battery optimization blocks ringing.
- Notification presentation is idempotent: a push already presented for a
  callId is not re-alerted by the later SIP INVITE. Dismissal is per-call; one
  call ending or being canceled cannot cancel another ringing call's
  notification.
- Notification permission can be revoked at app or channel level after grant.
  `CallNotificationModule.areCallNotificationsEnabled()` checks both; the App
  permission banner uses it.

---

## 5. Wake/SIP behavior

`SokratFirebaseMessagingService` forwards the FCM payload to
`ReactNativeFirebaseMessagingReceiver`; background/headless JS runs
`src/push/pushHandler.ts`. A `cancel-call` removes the native record/notification
and the persisted pending call. An incoming call persists before presentation and
is delivered to the mounted App; if the App is not mounted, headless JS
bootstraps the approved SIP session.

The wake ACK is sent only after `JsSipService.isRegistered()` reports success;
`isRegistered()` is local UA state, not a fresh PBX contact probe. The 120 s
registration refresh and 20 s keepalive are local checks. A half-open WebSocket
can therefore report a stale registered state; the heartbeat path logs
`heartbeat ACK deferred`, `no gateway session`, or `heartbeat ACK failed` to
distinguish the failing phase. A wake that arrives while a call or consultation
leg is active is ignored without reconnecting SIP or sending an ACK, so it
cannot replace the transport under the live call.

**Cold vs background:** an idle `SokratConnectionService` foreground service means
the app process is not process-cold. Android force-stop blocks FCM by design and
is not equivalent to normal process eviction. For a valid cold test on Android 13+
use the documented stop command and verify the process is gone and the package is
not stopped:

```bash
adb shell cmd activity stop-app com.sokratmobile
adb shell pidof com.sokratmobile          # must be empty
```

Also verify through the parent-owned device procedure that the package is not in
the stopped state (`stopped=false`); `cmd activity stop-app` is not the same as
force-stop.

The app does not start a microphone foreground service from the background just
because a wake arrives. Any such promotion needs an Android high-priority FCM /
user-visible proof and explicit approval.

---

## 6. Local checks

```bash
npm test                       # Jest (native VoIP/Firebase mocked)
npm run lint
```

Focused push behavior:
```bash
npx jest __tests__/incomingAnswer.test.tsx
npx jest __tests__/pushRegistration.test.ts
```

Native JVM policy tests (no Robolectric):
```bash
cd android && ./gradlew testDebugUnitTest --tests '*IncomingPushPolicyTest'
```

No test prints or persists FCM tokens, claim secrets, or SIP passwords. Treat any
raw `data.token`/`voipToken` as a credential; diagnostics expose only presence/
timestamps/error codes.

## Gateway failure messages

Every gateway failure maps to one sentence in `src/gateway/errors.ts`. Support
should read the message, not the log:

| Message | Cause | Action |
|---|---|---|
| Waiting for administrator approval… | Device is pending, or re-requested after an extension change | Approve the device in the gateway dashboard |
| Cannot reach the gateway… | No TLS/connectivity to the origin | Check network and the Server field |
| The gateway is busy. Retrying… | Origin answered 429/5xx (deploy, reload, burst) | Nothing; the app retries |
| The server answered, but not as a PBX gateway… | 404/odd status: wrong port or vhost in the Server field | Correct the host/port |
| The network blocked the gateway request… | 401/403 from an intermediary | Retry on another network |
| Revoke the old device in the gateway dashboard… | 409 identity conflict (reinstall under an existing approval) | Revoke the stale device, then sign in |
| The app could not read its saved gateway enrollment… | Local storage fault or invalid record | Sign in again to re-enroll |
| This device has been revoked… | Admin revoked the device | Re-enroll and approve |
| Gateway detected but unreachable… | Fail-closed refusal to bypass a gateway; nothing else | Report it: this sentence must not appear for the cases above |
