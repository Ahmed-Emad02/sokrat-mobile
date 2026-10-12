import { DeviceEventEmitter, Platform, NativeModules } from 'react-native';

const CallNotificationNative = NativeModules.CallNotificationModule;

export type GsmCallState = 'IDLE' | 'RINGING' | 'OFFHOOK';

let cachedGsmState: GsmCallState = 'IDLE';

export async function getGsmCallState(): Promise<GsmCallState> {
  if (Platform.OS === 'android' && CallNotificationNative?.getGsmCallState) {
    try {
      const state = await CallNotificationNative.getGsmCallState();
      if (typeof state === 'string' && (state === 'RINGING' || state === 'OFFHOOK' || state === 'IDLE')) {
        cachedGsmState = state;
      }
    } catch {}
  }
  return cachedGsmState;
}

export function subscribeGsmCallState(listener: (state: GsmCallState) => void): () => void {
  void getGsmCallState().then((s) => listener(s));

  const sub = DeviceEventEmitter.addListener('onGsmCallStateChanged', (data: unknown) => {
    if (data && typeof data === 'object' && 'state' in data && typeof data.state === 'string') {
      const state = data.state as GsmCallState;
      if (state === 'RINGING' || state === 'OFFHOOK' || state === 'IDLE') {
        cachedGsmState = state;
        listener(state);
      }
    }
  });

  return () => sub.remove();
}
