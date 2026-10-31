import { NativeModules, Platform } from 'react-native';

type ConnectionServiceModule = {
  start?: () => void;
  stop?: () => void;
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

/** Stop the foreground service when no account remains. */
export function stopConnectionService(): void {
  if (Platform.OS !== 'android') return;
  try {
    native?.stop?.();
  } catch {
    // Best effort only.
  }
}
