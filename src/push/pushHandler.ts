/**
 * Sokrat VOICE push wake handler.
 *
 * Bridges the OS-level VoIP push (iOS PushKit + Android FCM high-priority)
 * into the app so it can: display the native incoming-call screen via
 * CallKit/Telecom, wake the SIP service, and register device tokens with
 * the push gateway on login / token refresh.
 */
import { Platform } from 'react-native';
import PushNotificationIOS from '@react-native-community/push-notification-ios';
import VoipPushNotification from 'react-native-voip-push-notification';
import { CONFIG } from '../config';

export type PushPayload = {
  type?: string;
  msg?: string;
  callerId?: string;
  callerName?: string;
  extension?: string;
  timestamp?: string;
  sipWss?: string;
};

type PushHandler = (payload: PushPayload) => void;

let onIncoming: PushHandler | null = null;
let currentExtension = '';
let voipTokenCache: string | null = null;
let fcmTokenCache: string | null = null;

/**
 * init() registers the native push listeners. Must be called once at app
 * boot, BEFORE AppRegistry, so a cold-started killed app wakes in time.
 */
export function initPush(onIncomingCall: PushHandler) {
  onIncoming = onIncomingCall;

  // ---------- iOS: PushKit (VoIP) ----------
  VoipPushNotification.registerVoipToken();

  VoipPushNotification.addEventListener('register', (token: string) => {
    voipTokenCache = token;
    console.log('[push] iOS VoIP token:', token);
    setTimeout(() => sendTokenToGateway('ios', token, token, currentExtension));
  });

  VoipPushNotification.addEventListener('notification', (payload: any) => {
    console.log('[push] voip notification', JSON.stringify(payload));
    const data: PushPayload = payload?.data || payload || {};
    if (onIncoming) {
      onIncoming({
        ...data,
        type: data.msg || 'incoming-call',
      });
    }
  });

  // iOS non-VoIP APNs fallback token
  PushNotificationIOS.addEventListener('register', (token: string) => {
    setTimeout(() => sendTokenToGateway('ios', token, null, currentExtension));
  });

  // ---------- Android: FCM high-priority data message ----------
  if (Platform.OS === 'android') {
    const FCM = require('@react-native-firebase/messaging').default;
    const messaging = FCM();

    messaging.setBackgroundMessageHandler(async (remoteMessage: any) => {
      const data = (remoteMessage?.data || {}) as PushPayload;
      if (data.msg === 'incoming-call' && onIncoming) {
        onIncoming({ ...data, type: 'incoming-call' });
      }
    });

    const handleToken = (token: string) => {
      fcmTokenCache = token;
      setTimeout(() => sendTokenToGateway('android', token, null, currentExtension));
    };
    messaging.getToken().then(handleToken).catch(() => {});
    messaging.onTokenRefresh(handleToken);
  }
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
    PushNotificationIOS.requestPermissions();
  }
}
