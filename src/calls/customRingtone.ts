/**
 * Plays a user-picked audio file as the incoming ringtone.
 *
 * react-native-incall-manager can only play the phone ringtone (`_DEFAULT_`) or
 * a bundled asset, so arbitrary files go through nitro-sound's MediaPlayer.
 * The file is restarted every time playback finishes to keep it ringing until
 * stopCustomRingtone() runs.
 */
import Sound from 'react-native-nitro-sound';

let generation = 0;
let activeUri: string | null = null;
let endListenerAttached = false;

function replay() {
  if (!activeUri) return;
  void Sound.startPlayer(activeUri).catch((err) => {
    console.warn('[incall] custom ringtone replay failed:', err);
  });
}

export async function startCustomRingtone(uri: string): Promise<void> {
  const token = ++generation;
  activeUri = uri;
  if (!endListenerAttached) {
    Sound.addPlaybackEndListener(replay);
    endListenerAttached = true;
  }
  try {
    await Sound.startPlayer(uri);
  } catch (err) {
    console.warn('[incall] custom ringtone failed:', err);
    return;
  }
  // A stop/answer that landed while the player was preparing wins.
  if (token !== generation) {
    try {
      await Sound.stopPlayer();
    } catch {}
  }
}

export async function stopCustomRingtone(): Promise<void> {
  ++generation;
  activeUri = null;
  if (endListenerAttached) {
    Sound.removePlaybackEndListener();
    endListenerAttached = false;
  }
  try {
    await Sound.stopPlayer();
  } catch {}
}
