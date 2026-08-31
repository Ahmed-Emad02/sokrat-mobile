/**
 * Sokrat VOICE in-call audio + proximity sensor.
 *
 * react-native-incall-manager controls the audio session and turns the
 * screen off when the phone is held to the ear (proximity sensor).
 */
import InCallManager from 'react-native-incall-manager';
import { Platform } from 'react-native';

export function startCallManagers() {
  InCallManager.start({ media: 'audio' });
  InCallManager.setMicrophoneMute(false);
  InCallManager.setForceSpeakerphoneOn(false);
  InCallManager.setKeepScreenOn(true);
}

export function stopCallManagers() {
  InCallManager.stop();
}

/** Route to the quiet speaker / switch to loudspeaker. */
export function setSpeakerphone(on: boolean) {
  InCallManager.setForceSpeakerphoneOn(on);
}

export function setKeepScreenOn(on: boolean) {
  InCallManager.setKeepScreenOn(on);
}
