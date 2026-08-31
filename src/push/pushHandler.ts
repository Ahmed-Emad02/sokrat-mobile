/**
 * Sokrat VOICE push wake handler.
 *
 * Bridges the OS-level VoIP push (iOS PushKit + Android FCM high-priority)
 * into the app so it can: display the native incoming-call screen via
 * CallKit/Telecom, wake the SIP service, and register device tokens with
 * the push gateway on login / token refresh.
 */
import { Platform } from 'react-native';
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
let pendingAndroidPayload: PushPayload | null = null;

// ---------- Android: FCM headless/background handler ----------
// Registered at MODULE scope (not inside App/useEffect) because when the app
// is in the background or killed, Android runs this in a headless JS instance
// with NO UI mounted. If we only registered inside initPush() (which runs from
// App's useEffect), a background data message would never be handled.
if (Platform.OS === 'android') {
  try {
    const messaging = getMessaging();
    setBackgroundMessageHandler(messaging, async (remoteMessage) => {
      const data = (remoteMessage?.data || {}) as PushPayload;
      if (data.msg !== 'incoming-call') return;
      if (onIncoming) {
        onIncoming({ ...data, type: 'incoming-call' });
      } else {
        // App not yet booted (cold start). Queue it; initPush() flushes it.
        pendingAndroidPayload = { ...data, type: 'incoming-call' };
      }
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

      // Listen for foreground FCM high-priority call messages
      onMessage(messaging, async (remoteMessage) => {
        console.log('[push] FCM foreground message received:', remoteMessage);
        const data = (remoteMessage?.data || {}) as PushPayload;
        if (data.msg === 'incoming-call' && onIncoming) {
          onIncoming({ ...data, type: 'incoming-call' });
        }
      });

      // Flush a background/cold-start payload that arrived before UI booted.
      if (pendingAndroidPayload) {
        const p = pendingAndroidPayload;
        pendingAndroidPayload = null;
        onIncoming && onIncoming(p);
      }
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
