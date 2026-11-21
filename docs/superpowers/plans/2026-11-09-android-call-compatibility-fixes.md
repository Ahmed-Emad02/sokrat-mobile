# Android Call Compatibility Fixes Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in the current session. Write a failing test before each change (`skill://test-driven`) and cite fresh evidence before claiming a task done (`skill://verification-before-completion`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the confirmed Android call-compatibility defects without changing PBX/backend behavior: background call audio, notification-permission readiness, canceled-call resurrection, GSM call-state permission, Bluetooth route correctness, and call volume routing.

**Architecture:** Keep the existing JsSIP/WebRTC call engine and native notification/FCM path. Promote the existing signaling foreground service to a microphone foreground service only during an active call; make notification permission failure visible and recoverable; enforce the incoming-call tombstone in native code; request the API 31+ telephony permission and refresh the native call-state listener; hide A2DP-only routes and wait for Bluetooth SCO state; set the native volume stream at call start and restore it at teardown.

**Tech Stack:** React Native, TypeScript, Kotlin/Android SDK 24–36, JsSIP, react-native-incall-manager, Jest, Gradle/JUnit.

**Spec:** The validated findings in the Scope section below are the specification for this plan; no separate design document exists.

## Global Constraints

- Keep `minSdk 24` and `targetSdk 36`.
- Do not add dependencies or change PBX, gateway, SIP routing, or native dialer behavior.
- Preserve the existing `SokratConnectionService` signaling behavior and its `specialUse` fallback.
- Do not bypass Android permissions or fabricate a foreground service without a real call use case.
- Do not commit unless the user explicitly asks.
- Keep all user-facing copy in the existing English style; the app already localizes selected labels.
- Android device verification is required for any claim that background audio, notifications, GSM preemption, or Bluetooth routing is fixed.

## Scope

Implement these valid code defects:

1. **Background microphone lifecycle.** The manifest has `RECORD_AUDIO` but no `FOREGROUND_SERVICE_MICROPHONE`, and the only service is `specialUse`. Promote the connection service to include the microphone type while a call is active, and demote it when the call ends.
2. **Notification-permission recovery.** The app requests `POST_NOTIFICATIONS` but silently degrades when denied. Show a persistent, actionable banner and refresh after permission changes.
3. **Canceled-call resurrection.** An incoming FCM push after a `cancel-call` tombstone can recreate a notification. Check `IncomingCallStore.isTerminated()` before presenting.
4. **GSM call-state permission.** API 31+ `TelephonyCallback.CallStateListener` requires `READ_PHONE_STATE`, which the manifest removes and the app does not request. Restore the permission, request it on modern Android, and re-register the listener after grant.
5. **Bluetooth route correctness.** A2DP-only devices are advertised as call routes but rejected by native communication-device selection. SCO is treated as ready before the audio stack reports it. Filter A2DP-only routes and wait for SCO state.
6. **Pre-answer volume stream.** Hardware volume keys use `STREAM_MUSIC` while an outgoing call is dialing because the voice stream is selected only after `onCallEstablished`. Select the voice stream when call audio starts and restore media when it stops.

Deferred, not code defects for this plan:

- No-GMS/Huawei HMS push fallback: requires a new push transport/backend and a product decision.
- Force-stopped apps: Android deliberately withholds background delivery; no app-side fix.
- Telecom/CallKit/DND integration: a larger product/design decision, not a defect in the current notification engine.
- Full-screen-intent denial and user-muted notification channels: user-controlled settings; the current fallback is intentional.
- PBX/TURN/dongle routing and OEM autostart policies: deployment/device policy, not app code in this repository.

## Review Focus

These are the failure modes most likely to bite a user after the fixes; each must be pinned by the named task.

1. **Active call backgrounded with microphone granted:** bidirectional audio must continue after Home/another app; no silent uplink loss.
2. **Notification permission denied or revoked:** the app must visibly explain the lack of incoming-call alerts and offer Settings; granting later must clear the warning.
3. **Cancel then duplicate incoming FCM:** the tombstone must win and no ghost call notification may reappear.
4. **API 31+ cellular call during SIP call:** permission grant must lead to hold, and GSM IDLE must lead to resume; denied permission must not crash the app.
5. **A2DP-only, HFP/SCO, and hardware-volume paths:** A2DP-only must not appear as a call route; HFP SCO must become selected after the state broadcast; volume keys during dialing must affect voice/call volume.

---

### Task 1: Promote the connection service to call-audio foreground service

**Files:**
- Modify: `android/app/src/main/AndroidManifest.xml:6-16,104-112`
- Modify: `android/app/src/main/java/com/sokratmobile/SokratConnectionService.kt`
- Modify: `android/app/src/main/java/com/sokratmobile/ConnectionServiceModule.kt`
- Modify: `src/calls/connectionService.ts`
- Modify: `src/calls/incall.ts:37-55`
- Test: `__tests__/incallForegroundService.test.js`
- Test: `__tests__/nativeCallActions.test.js`

**Interfaces:**
- Consumes: existing `startCallManagers()` and `stopCallManagers()`.
- Produces: `setCallAudioActive(active: boolean): void` in `src/calls/connectionService.ts`; native `ConnectionServiceModule.setCallAudioActive(active: Boolean)`; Kotlin `SokratConnectionService.setCallAudioActive(context: Context, active: Boolean)`.
- Produces: `SokratConnectionService.EXTRA_CALL_AUDIO = "com.sokratmobile.extra.CALL_AUDIO"`.
- Startup and sticky restarts must preserve the current call-audio flag when the intent has no extra.

- [ ] **Step 1: Write the failing call-lifecycle test**

Create `__tests__/incallForegroundService.test.js`:

```js
'use strict';
const { NativeModules, Platform } = require('react-native');

describe('Android call audio foreground service', () => {
  const originalOS = Platform.OS;
  let originalConnectionService;
  let originalCallNotificationModule;

  beforeEach(() => {
    originalConnectionService = NativeModules.SokratConnectionService;
    originalCallNotificationModule = NativeModules.CallNotificationModule;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    NativeModules.SokratConnectionService = {
      start: jest.fn(),
      stop: jest.fn(),
      setCallAudioActive: jest.fn(),
    };
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
    if (originalConnectionService === undefined) delete NativeModules.SokratConnectionService;
    else NativeModules.SokratConnectionService = originalConnectionService;
    if (originalCallNotificationModule === undefined) delete NativeModules.CallNotificationModule;
    else NativeModules.CallNotificationModule = originalCallNotificationModule;
    jest.clearAllMocks();
  });

  it('promotes the service when call managers start and demotes it on teardown', () => {
    let incall;
    jest.isolateModules(() => {
      incall = require('../src/calls/incall');
    });

    incall.startCallManagers();
    expect(NativeModules.SokratConnectionService.setCallAudioActive).toHaveBeenCalledWith(true);

    incall.stopCallManagers();
    expect(NativeModules.SokratConnectionService.setCallAudioActive).toHaveBeenLastCalledWith(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```sh
npx jest __tests__/incallForegroundService.test.js --runInBand
```

Expected: FAIL because `setCallAudioActive` is not called.

- [ ] **Step 3: Add the native declaration test**

Append to `__tests__/nativeCallActions.test.js`:

```js
test('the connection service can claim microphone foreground-service use for a call', () => {
  const manifest = fs.readFileSync(
    path.join(__dirname, '../android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );
  const service = read('SokratConnectionService.kt');

  expect(manifest).toContain('android.permission.FOREGROUND_SERVICE_MICROPHONE');
  expect(manifest).toMatch(/foregroundServiceType="specialUse\|microphone"/);
  expect(service).toContain('FOREGROUND_SERVICE_TYPE_MICROPHONE');
  expect(service).toContain('hasExtra(EXTRA_CALL_AUDIO)');
});
```

Expected before implementation: FAIL because the permission/type and extra handling are absent.

- [ ] **Step 4: Implement the manifest and native service changes**

In `AndroidManifest.xml` add:

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
```

Change the existing service declaration to:

```xml
android:foregroundServiceType="specialUse|microphone"
```

In `ConnectionServiceModule.kt` add:

```kotlin
@ReactMethod
fun setCallAudioActive(active: Boolean) {
    SokratConnectionService.setCallAudioActive(reactApplicationContext, active)
}
```

In `SokratConnectionService.kt`:

- Add `const val EXTRA_CALL_AUDIO = "com.sokratmobile.extra.CALL_AUDIO"` to the companion.
- Track `@Volatile private var callAudioActive = false`.
- In `onStartCommand`, update the flag only when `intent.hasExtra(EXTRA_CALL_AUDIO)`; otherwise preserve it. This matters for sticky restarts and the existing `startConnectionService()` wake path.
- Pass the flag to `startForegroundCompat`.
- On API 34+, call `startForeground` with `FOREGROUND_SERVICE_TYPE_SPECIAL_USE or FOREGROUND_SERVICE_TYPE_MICROPHONE` when active, otherwise `FOREGROUND_SERVICE_TYPE_SPECIAL_USE`.
- On API 29–33, use the three-argument `startForeground` with `FOREGROUND_SERVICE_TYPE_MICROPHONE` only when active; use the existing two-argument path when inactive.
- On API <29, keep the existing two-argument path.
- Catch `SecurityException` and `IllegalArgumentException` around promotion. On failure, log and fall back to the signaling-only notification; never crash the call because the service type was rejected.
- Change the notification text to `"Call in progress"` when audio is active and `"Ready for incoming calls"` otherwise.
- Add companion `setCallAudioActive(context, active)`: if the service instance is alive, apply the mode immediately; if active and no instance exists, start it with the extra from the foreground app; if inactive and no instance exists, do nothing.

- [ ] **Step 5: Wire the TypeScript lifecycle**

In `src/calls/connectionService.ts` add:

```ts
export function setCallAudioActive(active: boolean): void {
  if (Platform.OS !== 'android') return;
  try {
    native?.setCallAudioActive?.(active);
  } catch {
    // Call audio must still work if the native service promotion is unavailable.
  }
}
```

Extend the native module type with `setCallAudioActive?: (active: boolean) => void`.

In `src/calls/incall.ts`, import `setCallAudioActive`. Call `setCallAudioActive(true)` after `InCallManager.start(...)` in `startCallManagers()`, and `setCallAudioActive(false)` in `stopCallManagers()` after `InCallManager.stop()`.

- [ ] **Step 6: Run the focused tests**

Run:

```sh
npx jest __tests__/incallForegroundService.test.js __tests__/nativeCallActions.test.js --runInBand
npx jest __tests__/incallAudioRoute.test.js __tests__/incallNativeLifecycle.test.js --runInBand
npx tsc --noEmit
```

Expected: PASS. Existing call-route tests must still pass.

- [ ] **Step 7: Verify on a real API 34+ device**

1. Install the build and place a call.
2. While the call is active, run:

```sh
adb shell dumpsys activity services com.sokratmobile | grep -A12 SokratConnectionService
```

Expected: the service shows both `specialUse` and `microphone` foreground types during the call.
3. Press Home or open another app for at least 30 seconds. Verify both directions of audio.
4. End the call and repeat the dump. Expected: only the signaling/specialUse service remains.
5. Repeat on an API 33 or lower device. Expected: no startup crash when the service initially starts without the microphone type.

### Task 2: Make notification-permission denial visible and recoverable

**Files:**
- Create: `src/calls/callPermissions.ts`
- Modify: `App.tsx:250-260,931-1003,1848-1915`
- Test: `__tests__/callPermissions.test.ts`

**Interfaces:**
- Consumes: `canUseFullScreenIntent()` and `isIgnoringBatteryOptimizations()` from `src/calls/nativeCallNotification.ts`; `PermissionsAndroid` from React Native.
- Produces: `MissingCallPermissions` and `collectMissingCallPermissions(input: CallPermissionInput): MissingCallPermissions | null`.
- `MissingCallPermissions` fields are all **missing/unavailable** booleans: `fullScreen`, `battery`, `notifications`.

- [ ] **Step 1: Write the failing pure test**

Create `__tests__/callPermissions.test.ts`:

```ts
import { collectMissingCallPermissions } from '../src/calls/callPermissions';

test('returns null only when all calling surfaces are available', () => {
  expect(collectMissingCallPermissions({
    fullScreenAllowed: true,
    batteryOptimizationIgnored: true,
    notificationsAllowed: true,
  })).toBeNull();
});

test('marks a denied notification permission as the primary missing surface', () => {
  expect(collectMissingCallPermissions({
    fullScreenAllowed: true,
    batteryOptimizationIgnored: true,
    notificationsAllowed: false,
  })).toEqual({
    fullScreen: false,
    battery: false,
    notifications: true,
  });
});

test('reports all separate missing surfaces without conflating them', () => {
  expect(collectMissingCallPermissions({
    fullScreenAllowed: false,
    batteryOptimizationIgnored: false,
    notificationsAllowed: false,
  })).toEqual({
    fullScreen: true,
    battery: true,
    notifications: true,
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```sh
npx jest __tests__/callPermissions.test.ts --runInBand
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure permission state**

Create `src/calls/callPermissions.ts`:

```ts
export type CallPermissionInput = {
  fullScreenAllowed: boolean;
  batteryOptimizationIgnored: boolean;
  notificationsAllowed: boolean;
};

export type MissingCallPermissions = {
  fullScreen: boolean;
  battery: boolean;
  notifications: boolean;
};

export function collectMissingCallPermissions(
  input: CallPermissionInput,
): MissingCallPermissions | null {
  const missing = {
    fullScreen: !input.fullScreenAllowed,
    battery: !input.batteryOptimizationIgnored,
    notifications: !input.notificationsAllowed,
  };
  return missing.fullScreen || missing.battery || missing.notifications ? missing : null;
}
```

- [ ] **Step 4: Integrate permission reads and refresh**

In `App.tsx`:

- Replace the inline `missingCallPermissions` type with `import type { MissingCallPermissions }` and `useState<MissingCallPermissions | null>(null)`.
- Add `permissionRefreshRef = useRef<() => void>(() => {})`.
- In the existing permission refresh effect (`App.tsx:944-975`), read notification permission:

```ts
const notificationsAllowed =
  Platform.OS !== 'android' ||
  Platform.Version < 33 ||
  await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);

const next = collectMissingCallPermissions({
  fullScreenAllowed: fullScreen,
  batteryOptimizationIgnored: battery,
  notificationsAllowed,
});
setMissingCallPermissions(next);
```

- Store the refresh callback in `permissionRefreshRef.current` so the permission-request effect and AppState listener can call it.
- In the request effect (`App.tsx:980-1003`), call `permissionRefreshRef.current()` after `requestMultiple` resolves, including when permission is denied.
- In the `AppState` active listener, call the refresh callback after the existing refresh path.

- [ ] **Step 5: Make the banner actionable**

In the banner block (`App.tsx:1878-1915`):

- Show it when `missingCallPermissions` exists and either the user has not dismissed it or `missingCallPermissions.notifications` is true.
- Priority: notifications, then full-screen, then battery.
- Notification copy: `Incoming call alerts are disabled. Enable notifications to receive calls.`
- Notification button action: `void Linking.openSettings()`.
- Keep full-screen and battery actions unchanged.
- Hide the dismiss button when `notifications` is missing; this is not a warning the user can safely dismiss.
- Add a test in `__tests__/callPermissions.test.ts` that pins the notification-first message selection if you extract the message selection into a small pure function; otherwise pin the source branch in `__tests__/nativeCallActions.test.js`.

- [ ] **Step 6: Run the focused tests**

Run:

```sh
npx jest __tests__/callPermissions.test.ts __tests__/App.test.tsx --runInBand
npx tsc --noEmit
```

Expected: PASS, and `App` still renders.

- [ ] **Step 7: Verify on an API 33+ device**

1. Deny notifications, relaunch the app, and confirm the persistent banner and Settings action.
2. Grant notifications in Settings and return to the app. Confirm the banner clears on resume.
3. With notifications denied, confirm an incoming background call does not fail silently: the banner must already explain that alerts are disabled.

### Task 3: Guard incoming FCM after a call is terminated

**Files:**
- Modify: `android/app/src/main/java/com/sokratmobile/SokratFirebaseMessagingService.kt:28-67`
- Test: `__tests__/nativeCallActions.test.js`

**Interfaces:**
- Consumes: existing `IncomingCallStore.isTerminated(context, callId): Boolean`.
- Produces: no new public API; the incoming-call branch returns before `upsertIncoming` when the call ID has a live tombstone.

- [ ] **Step 1: Write the failing source/path test**

Append to `__tests__/nativeCallActions.test.js`:

```js
test('a terminated call cannot be resurrected by a delayed incoming push', () => {
  const service = read('SokratFirebaseMessagingService.kt');
  const incoming = service.slice(
    service.indexOf('val canonicalCallId = callId!!'),
    service.indexOf('if (IncomingCallStore.claimNotification'),
  );

  expect(incoming).toContain('IncomingCallStore.isTerminated');
  expect(incoming.indexOf('isTerminated')).toBeLessThan(
    incoming.indexOf('upsertIncoming'),
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```sh
npx jest __tests__/nativeCallActions.test.js --runInBand
```

Expected: FAIL because the FCM incoming path does not check the tombstone.

- [ ] **Step 3: Implement the guard**

In `SokratFirebaseMessagingService.onMessageReceived`, immediately after `canonicalCallId` is validated and before `DeviceContactLookup`/`upsertIncoming`, add:

```kotlin
if (IncomingCallStore.isTerminated(applicationContext, canonicalCallId)) {
    Log.i(TAG, "[callId=$canonicalCallId] ignored terminated incoming push")
    return
}
```

Do not forward a terminated call to React Native either; the tombstone already won.

- [ ] **Step 4: Run the test**

Run:

```sh
npx jest __tests__/nativeCallActions.test.js --runInBand
```

Expected: PASS, including the existing notification-action tests.

### Task 4: Restore GSM call-state permission and listener refresh

**Files:**
- Modify: `android/app/src/main/AndroidManifest.xml:21-25`
- Modify: `android/app/src/main/java/com/sokratmobile/CallNotificationModule.kt:145-170`
- Modify: `src/calls/nativeCallNotification.ts`
- Modify: `App.tsx:980-1003,1473-1498`
- Test: `__tests__/nativeCallActions.test.js`

**Interfaces:**
- Consumes: existing `handleCallState` and `subscribeGsmCallState` in the JS layer.
- Produces: `refreshTelephonyListener(): void` in `src/calls/nativeCallNotification.ts`; native `CallNotificationModule.refreshTelephonyListener()`.
- The native listener must be re-registered after a granted permission without restarting the app.

- [ ] **Step 1: Write the failing permission/source test**

Append to `__tests__/nativeCallActions.test.js`:

```js
test('API 31+ GSM call state requests and refreshes READ_PHONE_STATE', () => {
  const manifest = fs.readFileSync(
    path.join(__dirname, '../android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );
  const native = read('CallNotificationModule.kt');
  const app = fs.readFileSync(path.join(__dirname, '../App.tsx'), 'utf8');
  const wrapper = fs.readFileSync(
    path.join(__dirname, '../src/calls/nativeCallNotification.ts'),
    'utf8',
  );

  expect(manifest).toContain('android.permission.READ_PHONE_STATE');
  expect(manifest).not.toMatch(/READ_PHONE_STATE"\s+tools:node="remove"/);
  expect(native).toContain('fun refreshTelephonyListener');
  expect(app).toContain('READ_PHONE_STATE');
  expect(app).toContain('refreshTelephonyListener');
  expect(wrapper).toContain('refreshTelephonyListener');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```sh
npx jest __tests__/nativeCallActions.test.js --runInBand
```

Expected: FAIL on the removed permission and missing refresh method.

- [ ] **Step 3: Implement the permission and refresh path**

In `AndroidManifest.xml`, replace the `READ_PHONE_STATE` removal with:

```xml
<uses-permission android:name="android.permission.READ_PHONE_STATE" />
```

In `CallNotificationModule.kt`, add:

```kotlin
@ReactMethod
fun refreshTelephonyListener() {
    unregisterTelephonyListener()
    registerTelephonyListener()
}
```

In `src/calls/nativeCallNotification.ts`, add:

```ts
export function refreshTelephonyListener(): void {
  const mod = getModule();
  if (Platform.OS !== 'android' || !mod?.refreshTelephonyListener) return;
  try {
    mod.refreshTelephonyListener();
  } catch (error) {
    console.warn('[native-call] telephony listener refresh failed:', error);
  }
}
```

In `App.tsx`:

- Add `READ_PHONE_STATE` to the permission list only when `Platform.Version >= 31`.
- After `PermissionsAndroid.requestMultiple` resolves, call `refreshTelephonyListener()`.
- Add the same permission to `ensureCallPermissions()` so a user who grants it during an outbound attempt gets a refreshed listener.
- Do not block calls when the permission is denied; keep the existing in-app fallback and log the missing GSM preemption capability.

- [ ] **Step 4: Run the focused tests**

Run:

```sh
npx jest __tests__/nativeCallActions.test.js --runInBand
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Verify on an API 31+ device**

1. Grant phone permission when prompted.
2. Start an active SIP call.
3. Receive a cellular call. Expected: the SIP call is held.
4. End the cellular call. Expected: the SIP call resumes.
5. Deny the permission and repeat. Expected: no crash; the app still places SIP calls and only the preemption feature is unavailable.

### Task 5: Correct Bluetooth call routes and SCO readiness

**Files:**
- Modify: `android/app/src/main/java/com/sokratmobile/CallNotificationModule.kt:420-539`
- Modify: `src/calls/incall.ts:105-190`
- Test: `__tests__/nativeCallActions.test.js`
- Test: `__tests__/incallAudioRoute.test.js`

**Interfaces:**
- Consumes: existing `getAvailableAudioRoutes`, `setAudioRoute`, and `onSokratAudioDeviceChanged`.
- Produces: internal `waitForAudioRoute(route: AudioRouteType, timeoutMs: number): Promise<AudioDeviceState>`.
- A2DP-only devices must not produce a `BLUETOOTH` call-route entry; HFP/SCO, BLE headset, and hearing-aid devices must remain eligible.
- SCO selection must wait for `AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED` (with a bounded timeout), not four 250 ms retries.

- [ ] **Step 1: Write the failing route tests**

Append to `__tests__/nativeCallActions.test.js`:

```js
test('A2DP-only audio is not exposed as a call route', () => {
  const module = read('CallNotificationModule.kt');
  expect(module).not.toContain('TYPE_BLUETOOTH_A2DP -> "BLUETOOTH"');
  expect(module).not.toContain('a2dp == BluetoothProfile.STATE_CONNECTED');
  expect(module).toContain('ACTION_SCO_AUDIO_STATE_UPDATED');
});
```

Add to `__tests__/incallAudioRoute.test.js`:

```js
it('waits for the SCO state event before declaring Bluetooth selected', async () => {
  jest.useFakeTimers();
  NativeModules.CallNotificationModule = {
    setAudioRoute: jest.fn(async () => {}),
    getAvailableAudioRoutes: jest.fn(async () => ({
      availableDevices: ['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH'],
      selectedDevice: 'EARPIECE',
      hasBluetooth: true,
      bluetoothName: 'SCO headset',
    })),
  };

  let incall;
  jest.isolateModules(() => {
    incall = require('../src/calls/incall');
  });
  incall.startCallManagers();
  const pending = incall.chooseAudioRoute('BLUETOOTH');
  await Promise.resolve();

  DeviceEventEmitter.emit('onSokratAudioDeviceChanged', {
    availableAudioDeviceList: JSON.stringify(['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH']),
    selectedAudioDevice: 'BLUETOOTH',
    hasBluetooth: true,
    bluetoothName: 'SCO headset',
  });

  expect((await pending).selectedDevice).toBe('BLUETOOTH');
  incall.stopCallManagers();
  jest.useRealTimers();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```sh
npx jest __tests__/nativeCallActions.test.js __tests__/incallAudioRoute.test.js --runInBand
```

Expected: FAIL on A2DP mapping, the missing SCO broadcast action, and the route wait.

- [ ] **Step 3: Filter non-communication Bluetooth devices**

In `CallNotificationModule.kt`:

- Remove `AudioDeviceInfo.TYPE_BLUETOOTH_A2DP` from `mapAudioDeviceType`.
- Remove `BluetoothProfile.A2DP` from the profile block that sets `hasBluetooth` and adds `"BLUETOOTH"`. Keep the A2DP connection broadcast as a state-refresh trigger if desired, but do not use A2DP alone to advertise a call route.
- Keep `HEADSET` and actual communication-device types (`SCO`, `BLE_HEADSET`, `HEARING_AID`) eligible.

- [ ] **Step 4: Wait for SCO state while keeping a bounded fallback**

In `CallNotificationModule.kt`, add `AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED` to both the `when` actions and the `IntentFilter` in `registerBluetoothReceiver()`.

In `src/calls/incall.ts`, add `waitForAudioRoute`. It must:

- Resolve immediately if `getAudioDeviceState().selectedDevice === route`.
- Subscribe to the same event name used by `subscribeAudioDeviceChanges()`.
- Resolve when the emitted `selectedAudioDevice` equals the requested route.
- Use a 3,000 ms timeout, then refresh native state and resolve.
- Remove the listener and clear the timer on every exit.
- In `applyAudioRoute`, replace the current four-attempt 250 ms loop for `BLUETOOTH` with the event wait. Keep the final native state refresh; do not claim Bluetooth selected merely because `setAudioRoute` resolved.
- Update the existing “stops Bluetooth retries when the call is torn down” test to assert the wait/listener cleanup instead of the old retry count.

- [ ] **Step 5: Run the focused tests**

Run:

```sh
npx jest __tests__/incallAudioRoute.test.js __tests__/nativeCallActions.test.js --runInBand
npx tsc --noEmit
```

Expected: PASS. The existing serialization and teardown tests must still pass.

- [ ] **Step 6: Verify on hardware**

1. Pair an A2DP-only speaker. Open call audio settings. Expected: no Bluetooth call-route option.
2. Pair an HFP headset. Start a call and select Bluetooth. Expected: the route becomes Bluetooth after SCO connects; audio is bidirectional.
3. Switch to speaker/earpiece during a call and back to Bluetooth. Expected: the previous route does not remain selected.

### Task 6: Select the voice volume stream at call start

**Files:**
- Modify: `android/app/src/main/java/com/sokratmobile/CallNotificationModule.kt:873-900`
- Modify: `src/calls/nativeCallNotification.ts`
- Modify: `src/calls/incall.ts:37-55`
- Test: `__tests__/incallForegroundService.test.js`
- Test: `__tests__/nativeCallActions.test.js`

**Interfaces:**
- Produces: native `CallNotificationModule.beginCallAudio()` and `endCallAudio()`; TS `beginCallAudio(): void` and `endCallAudio(): void`.
- `beginCallAudio()` sets `volumeControlStream = AudioManager.STREAM_VOICE_CALL` on the current activity.
- `endCallAudio()` restores `volumeControlStream = AudioManager.STREAM_MUSIC`.

- [ ] **Step 1: Write the failing lifecycle test**

Append to `__tests__/incallForegroundService.test.js`:

```js
it('sets the voice stream when call managers start and restores media on teardown', () => {
  NativeModules.CallNotificationModule = {
    beginCallAudio: jest.fn(),
    endCallAudio: jest.fn(),
  };

  let incall;
  jest.isolateModules(() => {
    incall = require('../src/calls/incall');
  });

  incall.startCallManagers();
  expect(NativeModules.CallNotificationModule.beginCallAudio).toHaveBeenCalled();

  incall.stopCallManagers();
  expect(NativeModules.CallNotificationModule.endCallAudio).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```sh
npx jest __tests__/incallForegroundService.test.js --runInBand
```

Expected: FAIL because the native volume methods are not called.

- [ ] **Step 3: Implement the native methods**

In `CallNotificationModule.kt` add:

```kotlin
@ReactMethod
fun beginCallAudio() {
    reactApplicationContext.currentActivity?.runOnUiThread {
        it.volumeControlStream = AudioManager.STREAM_VOICE_CALL
    }
}

@ReactMethod
fun endCallAudio() {
    reactApplicationContext.currentActivity?.runOnUiThread {
        it.volumeControlStream = AudioManager.STREAM_MUSIC
    }
}
```

Use the existing `AudioManager` import; do not change the existing `setSpeakerVolume()` behavior.

In `src/calls/nativeCallNotification.ts` add guarded wrappers with the existing `getModule()`/`Platform.OS` pattern:

```ts
export function beginCallAudio(): void {
  const mod = getModule();
  if (Platform.OS !== 'android' || !mod?.beginCallAudio) return;
  try { mod.beginCallAudio(); } catch (error) {
    console.warn('[native-call] beginCallAudio failed:', error);
  }
}

export function endCallAudio(): void {
  const mod = getModule();
  if (Platform.OS !== 'android' || !mod?.endCallAudio) return;
  try { mod.endCallAudio(); } catch (error) {
    console.warn('[native-call] endCallAudio failed:', error);
  }
}
```

Call `beginCallAudio()` after `InCallManager.start(...)` in `startCallManagers()`, and `endCallAudio()` after `InCallManager.stop()` in `stopCallManagers()`.

- [ ] **Step 4: Add a native source test**

Append to `__tests__/nativeCallActions.test.js`:

```js
test('call lifecycle selects and restores the voice volume stream', () => {
  const module = read('CallNotificationModule.kt');
  expect(module).toContain('fun beginCallAudio');
  expect(module).toContain('fun endCallAudio');
  expect(module).toContain('volumeControlStream = AudioManager.STREAM_VOICE_CALL');
  expect(module).toContain('volumeControlStream = AudioManager.STREAM_MUSIC');
});
```

- [ ] **Step 5: Run the focused tests**

Run:

```sh
npx jest __tests__/incallForegroundService.test.js __tests__/nativeCallActions.test.js --runInBand
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Verify on hardware**

Start an outgoing call and press a hardware volume key while it is still dialing. Expected: the voice/call stream changes, not media volume. End the call and verify media volume keys control media again.

## Final Verification

- [ ] Run the complete JavaScript suite:

```sh
npx jest --runInBand
npx tsc --noEmit
```

Expected: all tests pass; no TypeScript errors.

- [ ] Run the Android unit tests:

```sh
cd android
./gradlew testDebugUnitTest --no-daemon
```

Expected: `BUILD SUCCESSFUL` and all JUnit tests pass.

- [ ] Run the release build once, outside task execution, using the project’s production signing environment.

- [ ] Device matrix:

| Scenario | API 26/27 | API 30/31 | API 33 | API 34/36 |
|---|---|---|---|---|
| Outgoing call after app has been backgrounded | | | | |
| Incoming call while screen locked | | | | |
| Notification permission denied then granted | n/a | n/a | required | required |
| GSM call during active SIP call | n/a | required | required | required |
| A2DP-only and HFP/SCO route switching | required | required | required | required |
| Hardware volume keys during dialing | required | required | required | required |

- [ ] No-GMS Huawei-class devices remain an explicitly documented unsupported path until a separate push-transport plan is approved.

## Self-Review

- **Spec coverage:** Tasks 1–6 cover every in-scope valid code defect: microphone FGS, notification permission, tombstone, GSM permission, Bluetooth A2DP/SCO, and volume stream.
- **Step scan:** Every step names the file, the exact test/command, and the expected result. Native fallbacks are specified rather than left to implementer choice.
- **Type consistency:** `MissingCallPermissions`, `collectMissingCallPermissions`, `setCallAudioActive`, `refreshTelephonyListener`, `waitForAudioRoute`, `beginCallAudio`, and `endCallAudio` are defined once and consumed by name in later tasks.
- **Review Focus:** Each of the five listed failure modes is assigned to a task test and a device verification step.
- **Out of scope:** No-GMS, force-stop, Telecom/DND, full-screen-intent denial, user-muted channels, PBX/TURN, OEM autostart, and notification lifetime are explicitly deferred.
