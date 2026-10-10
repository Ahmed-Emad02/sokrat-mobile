/**
 * Sokrat VOICE in-call audio + proximity sensor.
 *
 * react-native-incall-manager controls the audio session and turns the
 * screen off when the phone is held to the ear (proximity sensor).
 */
import InCallManager from 'react-native-incall-manager';
import { DeviceEventEmitter, Platform } from 'react-native';

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
    InCallManager.setForceSpeakerphoneOn(on);
    cachedSelectedDevice = on ? 'SPEAKER_PHONE' : 'EARPIECE';
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
      InCallManager.setForceSpeakerphoneOn(true);
    } else {
      InCallManager.setForceSpeakerphoneOn(false);
    }
    const res = await InCallManager.chooseAudioRoute(route);
    if (res?.availableAudioDeviceList) {
      cachedAudioDevices = parseDeviceList(res.availableAudioDeviceList);
    }
    if (res?.selectedAudioDevice) {
      cachedSelectedDevice = res.selectedAudioDevice as AudioRouteType;
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
