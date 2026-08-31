/**
 * Sokrat VOICE push wake handler.
 *
 * Bridges the OS-level VoIP push (iOS PushKit + Android FCM high-priority)
 * into the app so it can: display the native incoming-call screen via
 * CallKit/Telecom, wake the SIP service, and register device tokens with
 * the push gateway on login / token refresh.
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
import { generateUUID, reportIncomingCall } from '../calls/callKit';
import { CONFIG } from '../config';
export type PushPayload = {
  type?: string;
  msg?: string;
  callerId?: string;
  callerName?: string;
  extension?: string;
  timestamp?: string;
  sipWss?: string;
  callId?: string;
  nativePresented?: '1';
};

type PushHandler = (payload: PushPayload) => void;

const PENDING_CALL_KEY = '@sokrat/pending-incoming-call';
const MAX_PENDING_AGE_MS = 60_000;

let onIncoming: PushHandler | null = null;
let currentExtension = '';
let voipTokenCache: string | null = null;
let fcmTokenCache: string | null = null;
let pendingAndroidPayload: PushPayload | null = null;
let lastDeliveredCallId = '';

function normalizeIncomingPayload(data: PushPayload): PushPayload {
  return {
    ...data,
    type: 'incoming-call',
    msg: 'incoming-call',
    callId: data.callId || generateUUID(),
    timestamp: data.timestamp || String(Date.now()),
  };
}

function isFresh(payload: PushPayload): boolean {
  const timestamp = Number(payload.timestamp || 0);
  return Number.isFinite(timestamp) && Date.now() - timestamp <= MAX_PENDING_AGE_MS;
}

async function persistPendingCall(payload: PushPayload): Promise<void> {
  await AsyncStorage.setItem(PENDING_CALL_KEY, JSON.stringify(payload));
}

async function loadPendingCall(): Promise<PushPayload | null> {
  try {
    const encoded = await AsyncStorage.getItem(PENDING_CALL_KEY);
    if (!encoded) return null;
    const payload = JSON.parse(encoded) as PushPayload;
    if (!payload.callId || !isFresh(payload)) {
      await AsyncStorage.removeItem(PENDING_CALL_KEY);
      return null;
    }
    return payload;
  } catch (err) {
    console.warn('[push] failed to load pending call:', err);
    return null;
  }
}

function deliverIncomingCall(payload: PushPayload) {
  if (payload.callId && payload.callId === lastDeliveredCallId) return;
  lastDeliveredCallId = payload.callId || '';
  if (onIncoming) {
    onIncoming(payload);
  } else {
    pendingAndroidPayload = payload;
  }
}

async function presentNativeIncomingCall(payload: PushPayload): Promise<PushPayload> {
  if (payload.nativePresented === '1') return payload;
  const displayed = await reportIncomingCall(
    payload.callId || generateUUID(),
    payload.callerId || 'Unknown',
    payload.callerName || payload.callerId || 'Incoming Call',
  );
  if (!displayed) return payload;
  const presented: PushPayload = { ...payload, nativePresented: '1' };
  await persistPendingCall(presented);
  return presented;
}

export async function markIncomingCallPresented(callId: string): Promise<void> {
  const pending = await loadPendingCall();
  if (!pending || pending.callId !== callId || pending.nativePresented === '1') return;
  await persistPendingCall({ ...pending, nativePresented: '1' });
}

export async function clearPendingIncomingCall(callId?: string): Promise<void> {
  if (callId) {
    const pending = await loadPendingCall();
    if (pending && pending.callId !== callId) return;
  }
  await AsyncStorage.removeItem(PENDING_CALL_KEY);
  if (!callId || pendingAndroidPayload?.callId === callId) {
    pendingAndroidPayload = null;
  }
}

// Android invokes this module-scope handler in a headless JS runtime when the
// app is backgrounded or killed. It owns native call presentation but never
// creates a second SIP user agent or opens audio.
if (Platform.OS === 'android') {
  try {
    const messaging = getMessaging();
    setBackgroundMessageHandler(messaging, async (remoteMessage) => {
      const data = (remoteMessage?.data || {}) as PushPayload;
      if (data.msg !== 'incoming-call') return;

      let payload = normalizeIncomingPayload(data);
      const persisted = await loadPendingCall();
      if (persisted && persisted.callId === payload.callId) {
        payload = persisted;
      } else {
        await persistPendingCall(payload);
      }
      payload = await presentNativeIncomingCall(payload);
      deliverIncomingCall(payload);
    });
  } catch (err) {
    console.warn('[push] FCM background handler init failed:', err);
  }
}

/**
 * init() registers the native push listeners. Must be called once at app
 * boot, BEFORE AppRegistry, so a cold-started killed app wakes in time.
 */
export function initPush(onIncomingCall: PushHandler) {
  onIncoming = onIncomingCall;

  // ---------- iOS: PushKit (VoIP) ----------
  if (Platform.OS === 'ios') {
    const VoipPushNotification = require('react-native-voip-push-notification').default || require('react-native-voip-push-notification');
    const PushNotificationIOS = require('@react-native-community/push-notification-ios').default || require('@react-native-community/push-notification-ios');

    VoipPushNotification.registerVoipToken();

    VoipPushNotification.addEventListener('register', (token: string) => {
      voipTokenCache = token;
      console.log('[push] iOS VoIP token:', token);
      setTimeout(() => sendTokenToGateway('ios', token, token, currentExtension));
    });

    VoipPushNotification.addEventListener('notification', (payload: { data?: PushPayload }) => {
      console.log('[push] voip notification', JSON.stringify(payload));
      const data: PushPayload = payload?.data || (payload as unknown as PushPayload) || {};
      deliverIncomingCall(normalizeIncomingPayload(data));
    });

    // iOS non-VoIP APNs fallback token
    PushNotificationIOS.addEventListener('register', (token: string) => {
      setTimeout(() => sendTokenToGateway('ios', token, null, currentExtension));
    });
  }
  // ---------- Android: FCM high-priority data message ----------
  if (Platform.OS === 'android') {
    try {
      const messaging = getMessaging();

      const handleToken = (token: string) => {
        fcmTokenCache = token;
        setTimeout(() => sendTokenToGateway('android', token, null, currentExtension));
      };
      getToken(messaging).then(handleToken).catch((err) => {
        console.warn('[push] getToken error:', err);
      });
      onTokenRefresh(messaging, handleToken);

      // Listen for foreground FCM high-priority call messages.
      onMessage(messaging, async (remoteMessage) => {
        console.log('[push] FCM foreground message received:', remoteMessage);
        const data = (remoteMessage?.data || {}) as PushPayload;
        if (data.msg !== 'incoming-call') return;
        const payload = normalizeIncomingPayload(data);
        await persistPendingCall(payload);
        deliverIncomingCall(payload);
      });

      // Flush a cold-start payload from either this runtime or AsyncStorage.
      void (async () => {
        const payload = pendingAndroidPayload || await loadPendingCall();
        pendingAndroidPayload = null;
        if (payload) deliverIncomingCall(payload);
      })();
    } catch (err) {
      console.warn('[push] FCM init error:', err);
    }
  }
  return;
}

/** Call after the user logs in so token registration knows the extension. */
export function bindExtension(extension: string) {
  currentExtension = extension;
  if (voipTokenCache) sendTokenToGateway('ios', voipTokenCache, voipTokenCache, extension);
  if (fcmTokenCache) sendTokenToGateway('android', fcmTokenCache, null, extension);
}

/** Re-register the current device token with the gateway (login time). */
export async function sendTokenToGateway(
  platform: 'ios' | 'android',
  token: string,
  voipToken: string | null,
  extension?: string,
) {
  const ext = extension || currentExtension;
  if (!ext) return; // not logged in yet
  try {
    const body: Record<string, any> = {
      extension: ext,
      platform,
      token,
      appVersion: CONFIG.appVersion,
    };
    if (platform === 'ios' && voipToken) body.voipToken = voipToken;

    const res = await fetch(`${CONFIG.pushGateway}/api/push/register-device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.success) console.warn('[push] gateway registration failed:', json.error);
  } catch (err) {
    // Gateway may be offline during local dev — non-fatal.
    console.warn('[push] gateway unreachable:', err);
  }
}

/** iOS: request notification permission (UnifiedPush / badge only). */
export function askNotificationPermission() {
  if (Platform.OS === 'ios') {
    const PushNotificationIOS = require('@react-native-community/push-notification-ios').default || require('@react-native-community/push-notification-ios');
    PushNotificationIOS.requestPermissions();
  } else if (Platform.OS === 'android') {
    try {
      const messaging = getMessaging();
      requestPermission(messaging).catch(() => {});
    } catch (err) {
      console.warn('[push] FCM requestPermission error:', err);
    }
  }
}
