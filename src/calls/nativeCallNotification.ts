import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const { CallNotificationModule } = NativeModules;

export type CallActionPayload = {
  action: 'ANSWER' | 'SHOW' | 'DECLINE';
  callId?: string;
  callerId?: string;
  callerName?: string;
  extension?: string;
  timestamp?: string;
};

const emitter =
  Platform.OS === 'android' && CallNotificationModule
    ? new NativeEventEmitter(CallNotificationModule)
    : null;

export function dismissNativeCallNotification() {
  if (Platform.OS === 'android' && CallNotificationModule?.dismissCallNotification) {
    try {
      CallNotificationModule.dismissCallNotification();
    } catch (e) {
      console.warn('[nativeCallNotification] dismiss error:', e);
    }
  }
}

export async function getInitialNativeCallAction(): Promise<CallActionPayload | null> {
  if (Platform.OS === 'android' && CallNotificationModule?.getInitialCallAction) {
    try {
      return await CallNotificationModule.getInitialCallAction();
    } catch (e) {
      console.warn('[nativeCallNotification] getInitialCallAction error:', e);
      return null;
    }
  }
  return null;
}

export function subscribeNativeCallAction(
  callback: (payload: CallActionPayload) => void,
): () => void {
  if (!emitter) return () => {};
  const subscription = emitter.addListener('onCallAction', (event: any) => {
    callback(event as CallActionPayload);
  });
  return () => {
    subscription.remove();
  };
}
