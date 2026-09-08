import { NativeModules, NativeEventEmitter, Platform, PermissionsAndroid } from 'react-native';

const getModule = () => NativeModules.CallNotificationModule;

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

let cachedEmitter: NativeEventEmitter | null = null;
function getEmitter(): NativeEventEmitter | null {
  if (Platform.OS !== 'android') return null;
  const mod = getModule();
  if (!cachedEmitter && mod) {
    cachedEmitter = new NativeEventEmitter(mod);
  }
  return cachedEmitter;
}

export function dismissNativeCallNotification(callId: string) {
  const mod = getModule();
  if (Platform.OS !== 'android' || !mod?.dismissCallNotification) return;
  try {
    mod.dismissCallNotification(callId);
  } catch (error) {
    console.warn('[native-call] dismiss failed:', error);
  }
}
export function clearNativeCallWindow() {
  const mod = getModule();
  if (Platform.OS !== 'android' || !mod?.clearCallWindow) return;
  try {
    mod.clearCallWindow();
  } catch (error) {
    console.warn('[native-call] clearCallWindow failed:', error);
  }
}


export async function getPendingNativeCalls(): Promise<CallActionPayload[]> {
  const mod = getModule();
  if (Platform.OS !== 'android' || !mod?.getPendingCalls) return [];
  try {
    const calls = await mod.getPendingCalls();
    return Array.isArray(calls) ? (calls as CallActionPayload[]) : [];
  } catch (error) {
    console.warn('[native-call] pending call load failed:', error);
    return [];
  }
}

export function acknowledgeNativeCallAction(callId: string, action: CallActionPayload['action']) {
  const mod = getModule();
  if (Platform.OS === 'android' && mod?.acknowledgeAction) {
    mod.acknowledgeAction(callId, action);
  }
}

export function recordNativeCallAction(callId: string, action: 'ANSWER' | 'DECLINE') {
  const mod = getModule();
  if (Platform.OS === 'android' && mod?.recordAction) {
    mod.recordAction(callId, action);
  }
}

export function subscribeNativeCallAction(
  callback: (payload: CallActionPayload) => void,
): () => void {
  const emitterInstance = getEmitter();
  if (!emitterInstance) return () => {};
  const subscription = emitterInstance.addListener('onCallAction', (event: Object) => {
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
  const mod = getModule();
  if (Platform.OS === 'android' && mod?.getDeviceContacts) {
    try {
      const hasPermission = await requestContactsPermission();
      if (!hasPermission) return [];
      const contacts: DeviceContact[] = await mod.getDeviceContacts();
      return contacts || [];
    } catch (err) {
      console.warn('[contacts] fetchDeviceContacts failed:', err);
      return [];
    }
  }
  return [];
}

export interface SpeakerVolumeState {
  currentStep: number;
  maxStep: number;
  percent: number;
}

export async function setNativeSpeakerVolume(percent: number): Promise<SpeakerVolumeState | null> {
  const mod = getModule();
  console.log('[native-call] setNativeSpeakerVolume percent=' + percent + ' mod=' + (mod ? 'FOUND' : 'NULL'));
  if (Platform.OS !== 'android' || !mod?.setSpeakerVolume) {
    console.warn('[native-call] CallNotificationModule.setSpeakerVolume not available');
    return null;
  }
  try {
    const result = (await mod.setSpeakerVolume(percent)) as SpeakerVolumeState;
    console.log('[native-call] setSpeakerVolume success:', result);
    return result || null;
  } catch (error) {
    console.warn('[native-call] setSpeakerVolume failed:', error);
    return null;
  }
}

export async function getNativeSpeakerVolume(): Promise<SpeakerVolumeState> {
  const defaultState: SpeakerVolumeState = { currentStep: 12, maxStep: 15, percent: 80 };
  const mod = getModule();
  console.log('[native-call] getNativeSpeakerVolume mod=' + (mod ? 'FOUND' : 'NULL'));
  if (Platform.OS !== 'android' || !mod?.getSpeakerVolume) return defaultState;
  try {
    const result = (await mod.getSpeakerVolume()) as SpeakerVolumeState;
    console.log('[native-call] getNativeSpeakerVolume result:', result);
    return result || defaultState;
  } catch (err) {
    console.warn('[native-call] getNativeSpeakerVolume error:', err);
    return defaultState;
  }
}
