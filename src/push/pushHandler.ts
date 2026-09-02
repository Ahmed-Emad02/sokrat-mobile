/**
 * Push-to-wake transport. Android native code owns incoming-call UI; this
 * module only persists canonical payloads, bootstraps SIP, and registers the
 * device token.
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getMessaging,
  setBackgroundMessageHandler,
  onMessage,
  getToken,
  onTokenRefresh,
  requestPermission,
} from '@react-native-firebase/messaging';
import { CONFIG } from '../config';

export type PushPayload = {
  type: 'incoming-call';
  msg: 'incoming-call';
  callerId: string;
  callerName: string;
  extension: string;
  timestamp: string;
  sipWss?: string;
  callId: string;
  nativePresented: '1';
};

type RawPushPayload = Partial<PushPayload> & { msg?: string };
type PushHandler = (payload: PushPayload) => void;

const PENDING_CALLS_KEY = '@sokrat/pending-incoming-calls';
const DEVICE_UUID_KEY = '@sokrat/device-uuid';
const MAX_PENDING_AGE_MS = 90_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let onIncoming: PushHandler | null = null;
let currentExtension = '';
let voipTokenCache: string | null = null;
let fcmTokenCache: string | null = null;
let pendingAndroidPayload: PushPayload | null = null;
let lastDeliveredCallId = '';
let deviceUuidPromise: Promise<string> | null = null;

function createInstallUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

async function getDeviceUuid(): Promise<string> {
  if (!deviceUuidPromise) {
    deviceUuidPromise = (async () => {
      const stored = await AsyncStorage.getItem(DEVICE_UUID_KEY);
      if (stored && UUID_PATTERN.test(stored)) return stored;
      const created = createInstallUuid();
      await AsyncStorage.setItem(DEVICE_UUID_KEY, created);
      return created;
    })();
  }
  return deviceUuidPromise;
}

function normalizeIncomingPayload(data: RawPushPayload): PushPayload | null {
  if (data.msg !== 'incoming-call' || !data.callId || !UUID_PATTERN.test(data.callId)) {
    console.error(`[push] rejected incoming payload: invalid callId=${data.callId || 'missing'}`);
    return null;
  }
  return {
    type: 'incoming-call',
    msg: 'incoming-call',
    callerId: data.callerId || 'Unknown',
    callerName: data.callerName || data.callerId || 'Incoming Call',
    extension: data.extension || '',
    timestamp: data.timestamp || String(Date.now()),
    sipWss: data.sipWss,
    callId: data.callId,
    nativePresented: '1',
  };
}

function isFresh(payload: PushPayload): boolean {
  const timestamp = Number(payload.timestamp);
  return Number.isFinite(timestamp) &&
    timestamp > 0 &&
    Math.abs(Date.now() - timestamp) <= MAX_PENDING_AGE_MS;
}

async function loadPendingCalls(): Promise<Record<string, PushPayload>> {
  try {
    const encoded = await AsyncStorage.getItem(PENDING_CALLS_KEY);
    if (!encoded) return {};
    const parsed = JSON.parse(encoded) as Record<string, PushPayload>;
    const fresh = Object.fromEntries(
      Object.entries(parsed).filter(([callId, payload]) =>
        UUID_PATTERN.test(callId) && payload.callId === callId && isFresh(payload)
      ),
    );
    if (Object.keys(fresh).length !== Object.keys(parsed).length) {
      await AsyncStorage.setItem(PENDING_CALLS_KEY, JSON.stringify(fresh));
    }
    return fresh;
  } catch (error) {
    console.warn('[push] failed to load pending calls:', error);
    return {};
  }
}

async function persistPendingCall(payload: PushPayload): Promise<void> {
  const calls = await loadPendingCalls();
  calls[payload.callId] = payload;
  await AsyncStorage.setItem(PENDING_CALLS_KEY, JSON.stringify(calls));
}

async function loadNewestPendingCall(): Promise<PushPayload | null> {
  const calls = Object.values(await loadPendingCalls());
  return calls.sort((left, right) => Number(right.timestamp) - Number(left.timestamp))[0] || null;
}

function deliverIncomingCall(payload: PushPayload) {
  if (payload.callId === lastDeliveredCallId) return;
  lastDeliveredCallId = payload.callId;
  console.log(`[push][callId=${payload.callId}] delivered to call state machine`);
  if (onIncoming) onIncoming(payload);
  else pendingAndroidPayload = payload;
}

export async function clearPendingIncomingCall(callId?: string): Promise<void> {
  if (!callId) {
    await AsyncStorage.removeItem(PENDING_CALLS_KEY);
    pendingAndroidPayload = null;
    lastDeliveredCallId = '';
    return;
  }
  const calls = await loadPendingCalls();
  delete calls[callId];
  await AsyncStorage.setItem(PENDING_CALLS_KEY, JSON.stringify(calls));
  if (pendingAndroidPayload?.callId === callId) pendingAndroidPayload = null;
  if (lastDeliveredCallId === callId) lastDeliveredCallId = '';
}

if (Platform.OS === 'android') {
  try {
    const messaging = getMessaging();
    setBackgroundMessageHandler(messaging, async (remoteMessage) => {
      const payload = normalizeIncomingPayload((remoteMessage?.data || {}) as RawPushPayload);
      if (!payload) return;
      await persistPendingCall(payload);
      console.log(`[push][callId=${payload.callId}] headless payload persisted`);
      deliverIncomingCall(payload);
    });
  } catch (error) {
    console.warn('[push] FCM background handler init failed:', error);
  }
}

export function initPush(onIncomingCall: PushHandler) {
  onIncoming = onIncomingCall;

  if (Platform.OS === 'ios') {
    const VoipPushNotification =
      require('react-native-voip-push-notification').default ||
      require('react-native-voip-push-notification');
    const PushNotificationIOS =
      require('@react-native-community/push-notification-ios').default ||
      require('@react-native-community/push-notification-ios');

    VoipPushNotification.registerVoipToken();
    VoipPushNotification.addEventListener('register', (token: string) => {
      voipTokenCache = token;
      setTimeout(() => sendTokenToGateway('ios', token, token, currentExtension));
    });
    VoipPushNotification.addEventListener(
      'notification',
      (message: { data?: RawPushPayload }) => {
        const payload = normalizeIncomingPayload(
          message?.data || message as unknown as RawPushPayload,
        );
        if (payload) deliverIncomingCall(payload);
      },
    );
    PushNotificationIOS.addEventListener('register', (token: string) => {
      setTimeout(() => sendTokenToGateway('ios', token, null, currentExtension));
    });
  }

  if (Platform.OS === 'android') {
    try {
      const messaging = getMessaging();
      const handleToken = (token: string) => {
        fcmTokenCache = token;
        setTimeout(() => sendTokenToGateway('android', token, null, currentExtension));
      };
      getToken(messaging).then(handleToken).catch((error) => {
        console.warn('[push] getToken failed:', error);
      });
      onTokenRefresh(messaging, handleToken);
      onMessage(messaging, async (remoteMessage) => {
        const payload = normalizeIncomingPayload(
          (remoteMessage?.data || {}) as RawPushPayload,
        );
        if (!payload) return;
        await persistPendingCall(payload);
        deliverIncomingCall(payload);
      });
      void (async () => {
        const payload = pendingAndroidPayload || await loadNewestPendingCall();
        pendingAndroidPayload = null;
        if (payload) deliverIncomingCall(payload);
      })();
    } catch (error) {
      console.warn('[push] FCM init failed:', error);
    }
  }
}

export function bindExtension(extension: string) {
  currentExtension = extension;
  if (voipTokenCache) void sendTokenToGateway('ios', voipTokenCache, voipTokenCache, extension);
  if (fcmTokenCache) void sendTokenToGateway('android', fcmTokenCache, null, extension);
}

export async function sendTokenToGateway(
  platform: 'ios' | 'android',
  token: string,
  voipToken: string | null,
  extension?: string,
) {
  const ext = extension || currentExtension;
  if (!ext) return;
  try {
    const body: Record<string, string> = {
      extension: ext,
      platform,
      token,
      deviceUuid: await getDeviceUuid(),
      appVersion: CONFIG.appVersion,
    };
    if (platform === 'ios' && voipToken) body.voipToken = voipToken;
    const response = await fetch(`${CONFIG.pushGateway}/api/push/register-device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await response.json();
    if (!response.ok || !json.success) {
      console.warn('[push] gateway registration failed:', json.error || response.status);
    }
  } catch (error) {
    console.warn('[push] gateway unreachable:', error);
  }
}

export async function unregisterCurrentDevice(): Promise<void> {
  if (!currentExtension) return;
  try {
    await fetch(`${CONFIG.pushGateway}/api/push/remove-device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        extension: currentExtension,
        platform: Platform.OS,
        deviceUuid: await getDeviceUuid(),
      }),
    });
  } catch (error) {
    console.warn('[push] device removal failed:', error);
  }
}

export function askNotificationPermission() {
  if (Platform.OS === 'ios') {
    const PushNotificationIOS =
      require('@react-native-community/push-notification-ios').default ||
      require('@react-native-community/push-notification-ios');
    PushNotificationIOS.requestPermissions();
  } else if (Platform.OS === 'android') {
    try {
      requestPermission(getMessaging()).catch(() => {});
    } catch (error) {
      console.warn('[push] FCM permission request failed:', error);
    }
  }
}
