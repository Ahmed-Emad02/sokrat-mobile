/**
 * Sokrat VOICE in-call audio + proximity sensor.
 *
 * react-native-incall-manager controls the audio session and turns the
 * screen off when the phone is held to the ear (proximity sensor).
 */
import InCallManager from 'react-native-incall-manager';
import { DeviceEventEmitter, Platform, NativeModules } from 'react-native';
import { DEFAULT_INCOMING_RINGTONE, normalizeIncomingRingtone } from './ringtonePref';
import type { IncomingRingtone } from './ringtonePref';
import { startCustomRingtone, stopCustomRingtone } from './customRingtone';
import { setCallAudioActive } from './connectionService';
import { beginCallAudio, endCallAudio } from './nativeCallNotification';

const CallNotificationNative = NativeModules.CallNotificationModule;

export type AudioRouteType = 'EARPIECE' | 'SPEAKER_PHONE' | 'BLUETOOTH' | 'WIRED_HEADSET';

export interface AudioDeviceState {
  availableDevices: AudioRouteType[];
  selectedDevice: AudioRouteType;
  hasBluetooth: boolean;
  bluetoothName?: string;
}

let cachedAudioDevices: AudioRouteType[] = ['EARPIECE', 'SPEAKER_PHONE'];
let cachedSelectedDevice: AudioRouteType = 'EARPIECE';
let cachedBluetoothName = '';
let audioSessionGeneration = 0;
let audioSessionActive = false;
let outgoingRingbackActive = false;
let outgoingRingbackStopTimer: ReturnType<typeof setTimeout> | null = null;
const OUTGOING_RINGBACK_MEDIA_HOLD_MS = 350;
let incomingRingtone: IncomingRingtone = DEFAULT_INCOMING_RINGTONE;
let incomingRingtoneUri: string | null = null;
let proximitySubscription: { remove: () => void } | null = null;
let proximityNear = false;

function applyProximityScreen() {
  if (!audioSessionActive) return;
  try {
    // InCallManager's own proximity handling is disabled when auto routing is
    // off (the native communication-device backend owns the route). Drive it
    // from the proximity event so the display still sleeps at the ear, and
    // stays on for speaker/headset routes.
    if (proximityNear && cachedSelectedDevice === 'EARPIECE') {
      InCallManager.turnScreenOff();
    } else {
      InCallManager.turnScreenOn();
    }
  } catch (err) {
    console.warn('[incall] proximity screen error:', err);
  }
}

function startProximityScreenControl() {
  if (proximitySubscription) return;
  proximitySubscription = DeviceEventEmitter.addListener(
    'Proximity',
    (data?: { isNear?: boolean }) => {
      if (!audioSessionActive) return;
      proximityNear = data?.isNear === true;
      applyProximityScreen();
    },
  );
}

function stopProximityScreenControl() {
  proximitySubscription?.remove();
  proximitySubscription = null;
  proximityNear = false;
}

function parseDeviceList(raw?: string): AudioRouteType[] {
  if (!raw) return ['EARPIECE', 'SPEAKER_PHONE'];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return arr as AudioRouteType[];
    }
  } catch {}
  return ['EARPIECE', 'SPEAKER_PHONE'];
}

export function startCallManagers() {
  // App.tsx starts the audio session when dialing, JsSipService starts it from
  // handleNewRTCSession, and the confirmed handler starts it again. A second
  // start() resets the audio mode/route under the active call and can cut the
  // first second of speech, so make the operation idempotent.
  if (audioSessionActive) return;
  ++audioSessionGeneration;
  audioSessionActive = true;
  const nativeRouting = hasNativeAudioRouting();
  if (nativeRouting) {
    startProximityScreenControl();
  }
  InCallManager.start({ media: 'audio', auto: !nativeRouting });
  beginCallAudio();
  setCallAudioActive(true);
  InCallManager.setMicrophoneMute(false);
  if (!nativeRouting) {
    InCallManager.setForceSpeakerphoneOn(false);
  }
  InCallManager.setKeepScreenOn(true);
}
export function stopCallManagers() {
  audioSessionActive = false;
  ++audioSessionGeneration;
  stopOutgoingRingback();
  stopProximityScreenControl();
  for (const cancel of routeWaiters) cancel();
  routeWaiters.clear();
  InCallManager.stop();
  endCallAudio();
  setCallAudioActive(false);
}

export function setIncomingRingtone(ringtone: IncomingRingtone, uri?: string | null): void {
  incomingRingtone = normalizeIncomingRingtone(ringtone);
  incomingRingtoneUri = incomingRingtone === 'custom' ? (uri?.trim() || null) : null;
  // A custom ringtone without a playable file must never silence the phone.
  if (incomingRingtone === 'custom' && !incomingRingtoneUri) {
    incomingRingtone = DEFAULT_INCOMING_RINGTONE;
  }
}

export function startRingtone() {
  if (Platform.OS === 'android' && incomingRingtone === 'custom' && incomingRingtoneUri) {
    void startCustomRingtone(incomingRingtoneUri);
    return;
  }
  try {
    // A positive duration makes InCallManager stop itself after that many
    // seconds. Ring until the call reaches a terminal state; answer, decline,
    // cancellation and call teardown all call stopRingtone(). `_DEFAULT_`
    // resolves to the phone's own ringtone on both platforms.
    InCallManager.startRingtone('_DEFAULT_', [0, 1000, 1000, 1000], 'playback', -1);
  } catch (err) {
    console.warn('[incall] startRingtone error:', err);
  }
}

export function startOutgoingRingback() {
  if (outgoingRingbackActive) return;
  if (outgoingRingbackStopTimer) {
    clearTimeout(outgoingRingbackStopTimer);
    outgoingRingbackStopTimer = null;
  }
  outgoingRingbackActive = true;
  try {
    // Android plays res/raw/incallmanager_ringback.wav through
    // react-native-incall-manager's MediaPlayer loop. `_DTMF_` is avoided: its
    // ToneGenerator path crashes the app on Android 16. `_DEFAULT_` is also
    // wrong here because the library resolves it to the incoming-call ringtone.
    const ringback = Platform.OS === 'android' ? '_BUNDLE_' : '_DEFAULT_';
    InCallManager.startRingback(ringback);
  } catch (err) {
    outgoingRingbackActive = false;
    console.warn('[incall] startRingback error:', err);
  }
}

export function stopRingtone() {
  void stopCustomRingtone();
  try {
    InCallManager.stopRingtone();
  } catch (err) {
    console.warn('[incall] stopRingtone error:', err);
  }
}

export function stopOutgoingRingback() {
  if (outgoingRingbackStopTimer) {
    clearTimeout(outgoingRingbackStopTimer);
    outgoingRingbackStopTimer = null;
  }
  outgoingRingbackActive = false;
  try {
    InCallManager.stopRingback();
  } catch (err) {
    console.warn('[incall] stopRingback error:', err);
  }
}

/**
 * Stop local ringback only after the peer's audio has had time to play out.
 *
 * WebRTC NetEq starts with a 300 ms minimum playout delay, and the first RTP
 * packet is buffered before any speech is audible. Stopping ringback on the
 * exact packet/answer event leaves a deterministic silent gap; holding the
 * local tone through that buffer makes the transition seamless. Teardown paths
 * still call stopOutgoingRingback() directly and cancel this timer.
 */
export function stopOutgoingRingbackAfterMedia() {
  if (!outgoingRingbackActive || outgoingRingbackStopTimer) return;
  outgoingRingbackStopTimer = setTimeout(() => {
    outgoingRingbackStopTimer = null;
    outgoingRingbackActive = false;
    try {
      InCallManager.stopRingback();
    } catch (err) {
      console.warn('[incall] stopRingback error:', err);
    }
  }, OUTGOING_RINGBACK_MEDIA_HOLD_MS);
}

export function setMicrophoneMute(muted: boolean) {
  try {
    InCallManager.setMicrophoneMute(muted);
  } catch (err) {
    console.warn('[incall] setMicrophoneMute error:', err);
  }
}

export function setCallWindowActive(active: boolean) {
  if (Platform.OS === 'android' && CallNotificationNative?.setCallActive) {
    void CallNotificationNative.setCallActive(active).catch?.(() => {});
  }
}

export function setKeepScreenOn(on: boolean) {
  try {
    InCallManager.setKeepScreenOn(on);
  } catch (err) {
    console.warn('[incall] setKeepScreenOn error:', err);
  }
}

// The Android communication device is authoritative. InCallManager maintains
// a second route state machine; letting both apply a route causes Bluetooth
// SCO and earpiece/speaker changes to race each other.
let routeQueue: Promise<AudioDeviceState> = Promise.resolve(getAudioDeviceState());

function hasNativeAudioRouting(): boolean {
  return Platform.OS === 'android' && typeof CallNotificationNative?.setAudioRoute === 'function';
}

const routeWaiters = new Set<() => void>();

function waitForAudioRoute(route: AudioRouteType, timeoutMs: number): Promise<AudioDeviceState> {
  const current = getAudioDeviceState();
  if (current.selectedDevice === route || !audioSessionActive) {
    return Promise.resolve(current);
  }

  return new Promise<AudioDeviceState>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: () => void;
    let subscription: { remove: () => void } | null = null;

    const finish = (state: AudioDeviceState) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      routeWaiters.delete(cancel);
      subscription?.remove();
      resolve(state);
    };
    cancel = () => finish(getAudioDeviceState());
    subscription = DeviceEventEmitter.addListener(
      hasNativeAudioRouting() ? 'onSokratAudioDeviceChanged' : 'onAudioDeviceChanged',
      (data: {
        availableAudioDeviceList?: string;
        selectedAudioDevice?: string;
        hasBluetooth?: boolean;
        bluetoothName?: string;
      }) => {
        if (data?.availableAudioDeviceList) {
          cachedAudioDevices = parseDeviceList(data.availableAudioDeviceList);
        }
        if (data?.selectedAudioDevice) {
          cachedSelectedDevice = data.selectedAudioDevice as AudioRouteType;
          applyProximityScreen();
        }
        if (data?.bluetoothName !== undefined) {
          cachedBluetoothName = data.bluetoothName || '';
        }
        const state = getAudioDeviceState();
        if (state.selectedDevice === route) finish(state);
      },
    );
    routeWaiters.add(cancel);
    timer = setTimeout(() => {
      void refreshNativeAudioState().then(finish).catch(() => finish(getAudioDeviceState()));
    }, timeoutMs);
  });
}

async function refreshNativeAudioState(): Promise<AudioDeviceState> {
  if (Platform.OS !== 'android' || typeof CallNotificationNative?.getAvailableAudioRoutes !== 'function') {
    return getAudioDeviceState();
  }
  const nativeRoutes = await CallNotificationNative.getAvailableAudioRoutes().catch?.(() => null);
  if (Array.isArray(nativeRoutes?.availableDevices)) {
    cachedAudioDevices = nativeRoutes.availableDevices as AudioRouteType[];
  }
  if (nativeRoutes?.selectedDevice) {
    cachedSelectedDevice = nativeRoutes.selectedDevice as AudioRouteType;
    applyProximityScreen();
  }
  if (nativeRoutes?.bluetoothName !== undefined) {
    cachedBluetoothName = nativeRoutes.bluetoothName || '';
  }
  return getAudioDeviceState();
}

async function applyAudioRoute(route: AudioRouteType, generation: number): Promise<AudioDeviceState> {
  if (!audioSessionActive || generation !== audioSessionGeneration) {
    return getAudioDeviceState();
  }
  // Do not publish the requested route before the audio stack confirms it.
  // The old optimistic assignment made a failed Bluetooth exit look applied
  // until the next snapshot arrived.
  try {
    let usedNative = hasNativeAudioRouting();
    if (usedNative) {
      if (!audioSessionActive || generation !== audioSessionGeneration) {
        return getAudioDeviceState();
      }
      try {
        await CallNotificationNative.setAudioRoute(route);
      } catch (nativeErr) {
        usedNative = false;
        console.warn('[incall] native chooseAudioRoute error:', nativeErr);
      }
      if (!audioSessionActive || generation !== audioSessionGeneration) {
        return getAudioDeviceState();
      }
    }

    if (!usedNative) {
      const speakerOn = route === 'SPEAKER_PHONE';
      InCallManager.setSpeakerphoneOn(speakerOn);
      InCallManager.setForceSpeakerphoneOn(speakerOn);
      const res = await InCallManager.chooseAudioRoute(route);
      if (res?.availableAudioDeviceList) {
        cachedAudioDevices = parseDeviceList(res.availableAudioDeviceList);
      }
      if (res?.selectedAudioDevice) {
        cachedSelectedDevice = res.selectedAudioDevice as AudioRouteType;
      }
    }

    let state = await refreshNativeAudioState();
    // Route application is asynchronous on both edges: SCO connects on the
    // way into Bluetooth and disconnects on the way out. Verify every target,
    // not only Bluetooth, so Earpiece/Speaker failures are surfaced instead
    // of being reported as success.
    if (usedNative && state.selectedDevice !== route) {
      state = await waitForAudioRoute(route, route === 'BLUETOOTH' ? 3000 : 2500);
    }
    if (usedNative && state.selectedDevice !== route) {
      console.warn(
        `[incall] audio route ${route} not applied; active=${state.selectedDevice}`,
      );
    }
    return state;
  } catch (err) {
    console.warn('[incall] chooseAudioRoute error:', err);
  }
  return getAudioDeviceState();
}

export function chooseAudioRoute(route: AudioRouteType): Promise<AudioDeviceState> {
  const generation = audioSessionGeneration;
  const next = routeQueue
    .catch(() => getAudioDeviceState())
    .then(() => {
      if (!audioSessionActive || generation !== audioSessionGeneration) {
        return getAudioDeviceState();
      }
      return applyAudioRoute(route, generation);
    });
  routeQueue = next.catch(() => getAudioDeviceState());
  return next;
}

export function getAudioDeviceState(): AudioDeviceState {
  return {
    availableDevices: cachedAudioDevices,
    selectedDevice: cachedSelectedDevice,
    hasBluetooth: cachedAudioDevices.includes('BLUETOOTH'),
    bluetoothName: cachedBluetoothName,
  };
}

export function subscribeAudioDeviceChanges(
  listener: (state: AudioDeviceState) => void
): () => void {
  listener(getAudioDeviceState());
  if (Platform.OS === 'android' && CallNotificationNative?.getAvailableAudioRoutes) {
    void CallNotificationNative.getAvailableAudioRoutes().then((res: { availableDevices?: string[]; selectedDevice?: string; hasBluetooth?: boolean; bluetoothName?: string }) => {
      if (res?.availableDevices) cachedAudioDevices = res.availableDevices as AudioRouteType[];
      if (res?.selectedDevice) cachedSelectedDevice = res.selectedDevice as AudioRouteType;
      if (res?.bluetoothName !== undefined) cachedBluetoothName = res.bluetoothName || '';
      listener({
        availableDevices: cachedAudioDevices,
        selectedDevice: cachedSelectedDevice,
        hasBluetooth: res?.hasBluetooth ?? cachedAudioDevices.includes('BLUETOOTH'),
        bluetoothName: cachedBluetoothName,
      });
    }).catch(() => {});
  }

  const sub = DeviceEventEmitter.addListener(
    hasNativeAudioRouting() ? 'onSokratAudioDeviceChanged' : 'onAudioDeviceChanged',
    (data: { availableAudioDeviceList?: string; selectedAudioDevice?: string; hasBluetooth?: boolean; bluetoothName?: string }) => {
      if (data?.availableAudioDeviceList) {
        cachedAudioDevices = parseDeviceList(data.availableAudioDeviceList);
      }
      if (data?.selectedAudioDevice) {
        cachedSelectedDevice = data.selectedAudioDevice as AudioRouteType;
        applyProximityScreen();
      }
      if (data?.bluetoothName !== undefined) {
        cachedBluetoothName = data.bluetoothName || '';
      }
      listener({
        availableDevices: cachedAudioDevices,
        selectedDevice: cachedSelectedDevice,
        hasBluetooth: data?.hasBluetooth ?? cachedAudioDevices.includes('BLUETOOTH'),
        bluetoothName: cachedBluetoothName,
      });
    }
  );

  return () => {
    sub.remove();
  };
}
