import { NativeModules, NativeEventEmitter, Platform, PermissionsAndroid } from 'react-native';

const { CallNotificationModule } = NativeModules;

export type CallActionPayload = {
  action: 'ANSWER' | 'SHOW' | 'DECLINE';
  callId: string;
  callerId: string;
  callerName: string;
  extension: string;
  timestamp: string;
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

export function dismissNativeCallNotification(callId: string) {
  if (Platform.OS !== 'android' || !CallNotificationModule?.dismissCallNotification) return;
  try {
    CallNotificationModule.dismissCallNotification(callId);
  } catch (error) {
    console.warn('[native-call] dismiss failed:', error);
  }
}
export function clearNativeCallWindow() {
  if (Platform.OS !== 'android' || !CallNotificationModule?.clearCallWindow) return;
  try {
    CallNotificationModule.clearCallWindow();
  } catch (error) {
    console.warn('[native-call] clearCallWindow failed:', error);
  }
}


export async function getPendingNativeCalls(): Promise<CallActionPayload[]> {
  if (Platform.OS !== 'android' || !CallNotificationModule?.getPendingCalls) return [];
  try {
    const calls = await CallNotificationModule.getPendingCalls();
    return Array.isArray(calls) ? calls as CallActionPayload[] : [];
  } catch (error) {
    console.warn('[native-call] pending call load failed:', error);
    return [];
  }
}

export function acknowledgeNativeCallAction(callId: string, action: CallActionPayload['action']) {
  if (Platform.OS === 'android' && CallNotificationModule?.acknowledgeAction) {
    CallNotificationModule.acknowledgeAction(callId, action);
  }
}

export function recordNativeCallAction(callId: string, action: 'ANSWER' | 'DECLINE') {
  if (Platform.OS === 'android' && CallNotificationModule?.recordAction) {
    CallNotificationModule.recordAction(callId, action);
  }
}

export function subscribeNativeCallAction(
  callback: (payload: CallActionPayload) => void,
): () => void {
  if (!emitter) return () => {};
  const subscription = emitter.addListener('onCallAction', (event: Object) => {
    callback(event as CallActionPayload);
  });
  return () => subscription.remove();
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

export async function setNativeSpeakerVolume(percent: number): Promise<void> {
  if (Platform.OS !== 'android' || !CallNotificationModule?.setSpeakerVolume) return;
  try {
    await CallNotificationModule.setSpeakerVolume(percent);
  } catch (error) {
    console.warn('[native-call] setSpeakerVolume failed:', error);
  }
}

export async function getNativeSpeakerVolume(): Promise<number> {
  if (Platform.OS !== 'android' || !CallNotificationModule?.getSpeakerVolume) return 80;
  try {
    return await CallNotificationModule.getSpeakerVolume();
  } catch {
    return 80;
  }
}
