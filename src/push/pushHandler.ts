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
import { getDeviceUuid, UUID_PATTERN } from '../storage/deviceId';
import {
  getOrLoadGatewaySession,
  getPersistedGatewayRecord,
  registerGatewayPushToken,
  removeGatewayPushToken,
} from '../gateway/session';
import type { GatewaySession } from '../gateway/types';

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
const MAX_PENDING_AGE_MS = 90_000;

let onIncoming: PushHandler | null = null;
let currentExtension = '';
let voipTokenCache: string | null = null;
let fcmTokenCache: string | null = null;
let pendingAndroidPayload: PushPayload | null = null;
let lastDeliveredCallId = '';

function normalizeIncomingPayload(data: RawPushPayload): PushPayload | null {
  if (data.msg !== 'incoming-call' || !data.callId || !UUID_PATTERN.test(data.callId)) {
    console.error(`[push] rejected incoming payload: invalid callId=${data.callId || 'missing'}`);
    return null;
  }
  return {
    type: 'incoming-call',
    msg: 'incoming-call',
    callerId: data.callerId || 'Unknown',
    callerName: 'Unknown',
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

      // If App.tsx is not mounted (cold wake / killed state), bootstrap SIP directly in Headless JS
      if (!onIncoming) {
        try {
          const { StorageService } = require('../storage/store');
          const { getSharedJsSipService } = require('../sip/JsSipService');
          const storedAccount = await StorageService.getAccount();
          if (storedAccount) {
            // Hydrate the approved gateway assignment first: a gateway-enrolled
            // device must wake through the ticket/relay path, never the direct
            // PBX socket. Pending/revoked records throw and abort the bootstrap.
            await getOrLoadGatewaySession(storedAccount.serverHost, storedAccount.extension);
            console.log(
              `[push][callId=${payload.callId}] headless bootstrapping SIP for ext=${storedAccount.extension}`
            );
            const headlessSip = getSharedJsSipService();
            if (!headlessSip.isConnectedOrConnecting()) {
              await headlessSip.connect(
                storedAccount.extension,
                storedAccount.password,
                storedAccount.serverHost,
                storedAccount.useTls,
              );
            }
          }
        } catch (bootstrapErr) {
          console.error('[push] headless SIP bootstrap error:', bootstrapErr);
        }
      }
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

/**
 * Resolve the approved gateway session for push traffic.
 *
 * Returns `undefined` when this host never enrolled with a gateway (legacy
 * `/api/push/*` endpoint) and `null` when a gateway is known but the device is
 * not approved yet (skip registration, never bypass).
 */
async function resolvePushGateway(
  host: string,
  extension: string,
): Promise<GatewaySession | null | undefined> {
  if (!host) return undefined;
  try {
    const record = await getPersistedGatewayRecord(host, extension);
    if (!record) return undefined;
    if (!record.assignment) {
      console.warn('[push] device approval pending; token registration skipped');
      return null;
    }
    return await getOrLoadGatewaySession(host, extension);
  } catch (error) {
    console.warn(
      '[push] gateway session unavailable:',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
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
    const deviceUuid = await getDeviceUuid();
    const gateway = await resolvePushGateway(CONFIG.sipDomain, ext);
    if (gateway === null) return;

    const body: Record<string, string> = {
      extension: gateway?.assignment.extension || ext,
      platform,
      token,
      deviceUuid,
      appVersion: CONFIG.appVersion,
    };
    if (platform === 'ios' && voipToken) body.voipToken = voipToken;

    if (gateway) {
      await registerGatewayPushToken(gateway, body);
      return;
    }

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
    const deviceUuid = await getDeviceUuid();
    const gateway = await resolvePushGateway(CONFIG.sipDomain, currentExtension);
    const body: Record<string, string> = {
      extension: gateway?.assignment.extension || currentExtension,
      platform: Platform.OS,
      deviceUuid,
    };

    if (gateway === null) return;
    if (gateway) {
      await removeGatewayPushToken(gateway, body);
      return;
    }

    await fetch(`${CONFIG.pushGateway}/api/push/remove-device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
