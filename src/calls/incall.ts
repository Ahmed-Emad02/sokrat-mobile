/**
 * Sokrat VOICE in-call audio + proximity sensor.
 *
 * react-native-incall-manager controls the audio session and turns the
 * screen off when the phone is held to the ear (proximity sensor).
 */
import InCallManager from 'react-native-incall-manager';
import { DeviceEventEmitter, Platform, NativeModules } from 'react-native';

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
  ++audioSessionGeneration;
  audioSessionActive = true;
  const nativeRouting = hasNativeAudioRouting();
  InCallManager.start({ media: 'audio', auto: !nativeRouting });
  InCallManager.setMicrophoneMute(false);
  if (!nativeRouting) {
    InCallManager.setForceSpeakerphoneOn(false);
  }
  InCallManager.setKeepScreenOn(true);
}
export function stopCallManagers() {
  audioSessionActive = false;
  ++audioSessionGeneration;
  InCallManager.stop();
}

export function startRingtone() {
  try {
    InCallManager.startRingtone('_DEFAULT_', [0, 1000, 1000, 1000], 'playback', 30);
  } catch (err) {
    console.warn('[incall] startRingtone error:', err);
  }
}

export function stopRingtone() {
  try {
    InCallManager.stopRingtone();
  } catch (err) {
    console.warn('[incall] stopRingtone error:', err);
  }
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
  cachedSelectedDevice = route;
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
    // SCO connects asynchronously. Retry the native selection briefly so a
    // Bluetooth tap does not leave the previous earpiece/speaker route active.
    if (usedNative && route === 'BLUETOOTH' && state.selectedDevice !== 'BLUETOOTH') {
      for (let attempt = 0; attempt < 4 && state.selectedDevice !== 'BLUETOOTH'; attempt++) {
        if (!audioSessionActive || generation !== audioSessionGeneration) {
          return getAudioDeviceState();
        }
        await new Promise<void>((resolve) => {
          setTimeout(() => resolve(), 250);
        });
        if (!audioSessionActive || generation !== audioSessionGeneration) {
          return getAudioDeviceState();
        }
        try {
          await CallNotificationNative.setAudioRoute(route);
        } catch {
          break;
        }
        if (!audioSessionActive || generation !== audioSessionGeneration) {
          return getAudioDeviceState();
        }
        state = await refreshNativeAudioState();
      }
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
