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
  // Route audio to the earpiece for voice calls.
  InCallManager.setForceSpeakerphoneOn(false);
  // Auto-mute on proximity for both platforms.
  InCallManager.setKeepScreenOn(true);
  if (Platform.OS === 'android') {
    // InCallManager uses the proximity sensor automatically when using
    // start('audio'). Keep the screen awake during a call.
    InCallManager.setKeepScreenOn(true);
  }
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
