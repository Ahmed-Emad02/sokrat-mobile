import { NativeModules, NativeEventEmitter, Platform, PermissionsAndroid } from 'react-native';

const { CallNotificationModule } = NativeModules;

export type CallActionPayload = {
  action: 'ANSWER' | 'SHOW' | 'DECLINE';
  callId?: string;
  callerId?: string;
  callerName?: string;
  extension?: string;
  timestamp?: string;
};
export type DeviceContact = {
  id: string;
  name: string;
  extension: string;
  favorite?: boolean;
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

export async function requestContactsPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    const hasPermission = await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.READ_CONTACTS,
    );
    if (hasPermission) return true;
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.READ_CONTACTS,
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  } catch (err) {
    console.warn('[contacts] permission request failed:', err);
    return false;
  }
}

export async function fetchDeviceContacts(): Promise<DeviceContact[]> {
  if (Platform.OS === 'android' && CallNotificationModule?.getDeviceContacts) {
    try {
      const hasPermission = await requestContactsPermission();
      if (!hasPermission) return [];
      const contacts: DeviceContact[] = await CallNotificationModule.getDeviceContacts();
      return contacts || [];
    } catch (err) {
      console.warn('[contacts] fetchDeviceContacts failed:', err);
      return [];
    }
  }
  return [];
}
