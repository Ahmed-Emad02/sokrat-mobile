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
}

let cachedAudioDevices: AudioRouteType[] = ['EARPIECE', 'SPEAKER_PHONE'];
let cachedSelectedDevice: AudioRouteType = 'EARPIECE';

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
  InCallManager.start({ media: 'audio' });
  InCallManager.setMicrophoneMute(false);
  InCallManager.setForceSpeakerphoneOn(false);
  InCallManager.setKeepScreenOn(true);
}
export function stopCallManagers() {
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

export function setSpeakerphone(on: boolean) {
  try {
    InCallManager.setSpeakerphoneOn(on);
    InCallManager.setForceSpeakerphoneOn(on);
    const targetRoute: AudioRouteType = on ? 'SPEAKER_PHONE' : 'EARPIECE';
    cachedSelectedDevice = targetRoute;
    void InCallManager.chooseAudioRoute(targetRoute);
    if (Platform.OS === 'android' && CallNotificationNative?.setSpeakerphone) {
      void CallNotificationNative.setSpeakerphone(on).catch?.(() => {});
    }
  } catch (err) {
    console.warn('[incall] setSpeakerphone error:', err);
  }
}

export function setKeepScreenOn(on: boolean) {
  try {
    InCallManager.setKeepScreenOn(on);
  } catch (err) {
    console.warn('[incall] setKeepScreenOn error:', err);
  }
}

export async function chooseAudioRoute(route: AudioRouteType): Promise<AudioDeviceState> {
  try {
    cachedSelectedDevice = route;
    if (route === 'SPEAKER_PHONE') {
      InCallManager.setSpeakerphoneOn(true);
      InCallManager.setForceSpeakerphoneOn(true);
    } else {
      InCallManager.setSpeakerphoneOn(false);
      InCallManager.setForceSpeakerphoneOn(false);
    }
    if (Platform.OS === 'android' && CallNotificationNative?.setAudioRoute) {
      await CallNotificationNative.setAudioRoute(route).catch?.(() => {});
    }
    const res = await InCallManager.chooseAudioRoute(route);
    if (res?.availableAudioDeviceList) {
      cachedAudioDevices = parseDeviceList(res.availableAudioDeviceList);
    }
    if (res?.selectedAudioDevice) {
      cachedSelectedDevice = res.selectedAudioDevice as AudioRouteType;
    }
    if (Platform.OS === 'android' && CallNotificationNative?.getAvailableAudioRoutes) {
      const nativeRoutes = await CallNotificationNative.getAvailableAudioRoutes().catch?.(() => null);
      if (nativeRoutes?.availableDevices) {
        cachedAudioDevices = nativeRoutes.availableDevices as AudioRouteType[];
      }
      if (nativeRoutes?.selectedDevice) {
        cachedSelectedDevice = nativeRoutes.selectedDevice as AudioRouteType;
      }
    }
  } catch (err) {
    console.warn('[incall] chooseAudioRoute error:', err);
  }
  return {
    availableDevices: cachedAudioDevices,
    selectedDevice: cachedSelectedDevice,
    hasBluetooth: cachedAudioDevices.includes('BLUETOOTH'),
  };
}

export function getAudioDeviceState(): AudioDeviceState {
  return {
    availableDevices: cachedAudioDevices,
    selectedDevice: cachedSelectedDevice,
    hasBluetooth: cachedAudioDevices.includes('BLUETOOTH'),
  };
}

export function subscribeAudioDeviceChanges(
  listener: (state: AudioDeviceState) => void
): () => void {
  listener(getAudioDeviceState());
  if (Platform.OS === 'android' && CallNotificationNative?.getAvailableAudioRoutes) {
    void CallNotificationNative.getAvailableAudioRoutes().then((res: { availableDevices?: string[]; selectedDevice?: string; hasBluetooth?: boolean }) => {
      if (res?.availableDevices) cachedAudioDevices = res.availableDevices as AudioRouteType[];
      if (res?.selectedDevice) cachedSelectedDevice = res.selectedDevice as AudioRouteType;
      listener({
        availableDevices: cachedAudioDevices,
        selectedDevice: cachedSelectedDevice,
        hasBluetooth: res?.hasBluetooth ?? cachedAudioDevices.includes('BLUETOOTH'),
      });
    }).catch(() => {});
  }

  const sub = DeviceEventEmitter.addListener(
    'onAudioDeviceChanged',
    (data: { availableAudioDeviceList?: string; selectedAudioDevice?: string }) => {
      if (data?.availableAudioDeviceList) {
        cachedAudioDevices = parseDeviceList(data.availableAudioDeviceList);
      }
      if (data?.selectedAudioDevice) {
        cachedSelectedDevice = data.selectedAudioDevice as AudioRouteType;
      }
      listener({
        availableDevices: cachedAudioDevices,
        selectedDevice: cachedSelectedDevice,
        hasBluetooth: cachedAudioDevices.includes('BLUETOOTH'),
      });
    }
  );

  return () => {
    sub.remove();
  };
}
