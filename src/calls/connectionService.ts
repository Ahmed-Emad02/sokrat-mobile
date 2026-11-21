import { NativeModules, Platform } from 'react-native';

type ConnectionServiceModule = {
  start?: () => void;
  stop?: () => void;
  setCallAudioActive?: (active: boolean) => void;
};

const native = NativeModules.SokratConnectionService as ConnectionServiceModule | undefined;

/** Start the Android foreground connection service; no-op on iOS/unsupported builds. */
export function startConnectionService(): void {
  if (Platform.OS !== 'android') return;
  try {
    native?.start?.();
  } catch {
    // A missing service must never prevent login or SIP registration.
  }
}

/** Promote or demote the Android foreground service for active call audio. */
export function setCallAudioActive(active: boolean): void {
  if (Platform.OS !== 'android') return;
  try {
    native?.setCallAudioActive?.(active);
  } catch {
    // Call audio must still work if the native service promotion is unavailable.
  }
}

/** Stop the foreground service when no account remains. */
export function stopConnectionService(): void {
  if (Platform.OS !== 'android') return;
  try {
    native?.stop?.();
  } catch {
    // Best effort only.
  }
}
