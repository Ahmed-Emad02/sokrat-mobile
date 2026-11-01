/**
 * Push-to-wake transport. Android native code owns incoming-call UI; this
 * module only persists canonical payloads, bootstraps SIP, and registers the
 * device token.
 */
import { AppState, Platform } from 'react-native';
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
import { callDisplayName } from '../calls/callerName';
import { getDeviceUuid, UUID_PATTERN } from '../storage/deviceId';
import type { SavedAccount } from '../storage/store';
import {
  getOrLoadGatewaySession,
  getPersistedGatewayRecord,
  registerGatewayPushToken,
  removeGatewayPushToken,
  sendGatewayHeartbeat,
} from '../gateway/session';
import type { GatewaySession } from '../gateway/types';
import { createRegistrationRetry } from './registrationRetry';

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

export type CancelPayload = {
  type: 'cancel-call';
  callId: string;
};

type RawPushPayload = Omit<Partial<PushPayload>, 'msg' | 'type'> & { msg?: string; type?: string };
type PushHandler = (payload: PushPayload) => void;
type CancelHandler = (payload: CancelPayload) => void;

const PENDING_CALLS_KEY = '@sokrat/pending-incoming-calls';
const MAX_PENDING_AGE_MS = 90_000;

let onIncoming: PushHandler | null = null;
let onCancel: CancelHandler | null = null;
let currentExtension = '';
let voipTokenCache: string | null = null;
let fcmTokenCache: string | null = null;
let pendingAndroidPayload: PushPayload | null = null;
let lastDeliveredCallId = '';
let lastWakeTimestamp = 0;
const registrationRetry = createRegistrationRetry();
const tokenRetry = createRegistrationRetry();
let tokenListenersInitialized = false;

function registerCachedToken() {
  const extension = currentExtension;
  const host = CONFIG.sipDomain;
  const token = Platform.OS === 'ios' ? voipTokenCache : fcmTokenCache;
  if (!extension || !host || !token) return;
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  registrationRetry.start(() =>
    sendTokenToGateway(platform, token, platform === 'ios' ? token : null, extension, host),
  );
}

function refreshAndroidToken() {
  if (Platform.OS !== 'android' || !currentExtension) return;
  tokenRetry.start(async () => {
    try {
      fcmTokenCache = await getToken(getMessaging());
      registerCachedToken();
      return true;
    } catch {
      console.warn('[push] FCM token unavailable; retry scheduled');
      return false;
    }
  });
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
    callerName: callDisplayName(data.callerId || ''),
    extension: data.extension || '',
    timestamp: data.timestamp || String(Date.now()),
    sipWss: data.sipWss,
    callId: data.callId,
    nativePresented: '1',
  };
}

export function normalizeCancelPayload(data: RawPushPayload): CancelPayload | null {
  if (data.msg !== 'cancel-call' || !data.callId || !UUID_PATTERN.test(data.callId)) {
    return null;
  }
  return { type: 'cancel-call', callId: data.callId };
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
  if (!onIncoming) {
    pendingAndroidPayload = payload;
    return;
  }
  lastDeliveredCallId = payload.callId;
  console.log(`[push][callId=${payload.callId}] delivered to call state machine`);
  onIncoming(payload);
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

async function handleWake(rawData: RawPushPayload): Promise<boolean> {
  if (rawData.msg !== 'wake' && rawData.type !== 'keepalive') return false;
  const wakeTimestamp = Number(rawData.timestamp) || 0;
  if (wakeTimestamp && wakeTimestamp === lastWakeTimestamp) return true;
  lastWakeTimestamp = wakeTimestamp;
  const { StorageService } = require('../storage/store');
  const storedAccount = await StorageService.getAccount();
  if (!storedAccount) return true;
  require('../calls/connectionService').startConnectionService();
  try {
    await sendGatewayHeartbeat(storedAccount.serverHost, storedAccount.extension, 'wake');
    if (wakeTimestamp) console.log(`[push] heartbeat ACK sent timestamp=${wakeTimestamp}`);
  } catch (heartbeatError) {
    console.warn('[push] heartbeat ACK failed:', heartbeatError);
  }
  if (!onIncoming) await bootstrapHeadlessSip(storedAccount, 'keepalive');
  return true;
}

async function bootstrapHeadlessSip(storedAccount: SavedAccount, label: string): Promise<void> {
  try {
    const { getSharedJsSipService } = require('../sip/JsSipService');
    // Hydrate the approved gateway assignment first: a gateway-enrolled device
    // must wake through the ticket/relay path, never the direct PBX socket.
    await getOrLoadGatewaySession(storedAccount.serverHost, storedAccount.extension);
    console.log(`[push][${label}] headless bootstrapping SIP for ext=${storedAccount.extension}`);
    const headlessSip = getSharedJsSipService();
    if (!headlessSip.isConnectedOrConnecting()) {
      await headlessSip.connect(
        storedAccount.extension,
        storedAccount.password,
        storedAccount.serverHost,
        storedAccount.useTls,
      );
    }
  } catch (bootstrapErr) {
    console.error('[push] headless SIP bootstrap error:', bootstrapErr);
  }
}

if (Platform.OS === 'android') {
  try {
    const messaging = getMessaging();
    setBackgroundMessageHandler(messaging, async (remoteMessage) => {
      const rawData = (remoteMessage?.data || {}) as RawPushPayload;
      if (await handleWake(rawData)) return;
      const cancelPayload = normalizeCancelPayload(rawData);
      if (cancelPayload) {
        console.log(`[push][callId=${cancelPayload.callId}] cancel-call received (background)`);
        await clearPendingIncomingCall(cancelPayload.callId);
        if (onCancel) onCancel(cancelPayload);
        return;
      }
      const payload = normalizeIncomingPayload(rawData);
      if (!payload) return;
      // FCM delivery can lag behind account switching. Never persist/present a
      // queued JS call for the previous extension or wake SIP under a new login.
      const { StorageService } = require('../storage/store');
      const storedAccount = await StorageService.getAccount();
      if (!storedAccount || payload.extension !== storedAccount.extension) {
        console.warn('[push] stale account payload ignored');
        return;
      }
      await persistPendingCall(payload);
      console.log(`[push][callId=${payload.callId}] headless payload persisted`);
      deliverIncomingCall(payload);

      // If App.tsx is not mounted (cold wake / killed state), bootstrap SIP directly in Headless JS.
      if (!onIncoming) await bootstrapHeadlessSip(storedAccount, `callId=${payload.callId}`);
    });
  } catch (error) {
    console.warn('[push] FCM background handler init failed:', error);
  }
}

export function initPush(onIncomingCall: PushHandler, onCancelCall?: CancelHandler) {
  onIncoming = onIncomingCall;
  onCancel = onCancelCall || null;

  if (Platform.OS === 'ios' && !tokenListenersInitialized) {
    tokenListenersInitialized = true;
    const VoipPushNotification =
      require('react-native-voip-push-notification').default ||
      require('react-native-voip-push-notification');
    const PushNotificationIOS =
      require('@react-native-community/push-notification-ios').default ||
      require('@react-native-community/push-notification-ios');

    VoipPushNotification.registerVoipToken();
    VoipPushNotification.addEventListener('register', (token: string) => {
      voipTokenCache = token;
      registerCachedToken();
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
      void sendTokenToGateway('ios', token, null, currentExtension);
    });
  }

  if (Platform.OS === 'android' && !tokenListenersInitialized) {
    try {
      const messaging = getMessaging();
      const handleToken = (token: string) => {
        fcmTokenCache = token;
        registerCachedToken();
      };
      onTokenRefresh(messaging, handleToken);
      onMessage(messaging, async (remoteMessage) => {
        const rawData = (remoteMessage?.data || {}) as RawPushPayload;
        if (await handleWake(rawData)) return;
        const cancelPayload = normalizeCancelPayload(rawData);
        if (cancelPayload) {
          console.log(`[push][callId=${cancelPayload.callId}] cancel-call received (foreground)`);
          await clearPendingIncomingCall(cancelPayload.callId);
          if (onCancel) onCancel(cancelPayload);
          return;
        }
        const payload = normalizeIncomingPayload(rawData);
        if (!payload) return;
        await persistPendingCall(payload);
        deliverIncomingCall(payload);
      });
      AppState.addEventListener('change', (state) => {
        if (state === 'active' && currentExtension) {
          registerCachedToken();
          refreshAndroidToken();
        }
      });
      tokenListenersInitialized = true;
      refreshAndroidToken();
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
  registrationRetry.stop();
  tokenRetry.stop();
  currentExtension = extension;
  registerCachedToken();
  if (!fcmTokenCache) refreshAndroidToken();
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
  host = CONFIG.sipDomain,
): Promise<boolean> {
  const ext = extension || currentExtension;
  if (!ext || !host) return false;
  try {
    const deviceUuid = await getDeviceUuid();
    const gateway = await resolvePushGateway(host, ext);
    if (gateway === null) return false;
    // Never register a stale request against a newly selected account.
    if (currentExtension !== ext || CONFIG.sipDomain !== host) return false;

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
      console.log('[push] tenant token registration confirmed');
      return true;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`${CONFIG.pushGateway}/api/push/register-device`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = await response.json();
      if (!response.ok || !json.success) {
        console.warn('[push] gateway registration failed; retry scheduled, HTTP', response.status);
        return false;
      }
    } finally {
      clearTimeout(timer);
    }
    console.log('[push] token registration confirmed');
    return true;
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    console.warn('[push] token registration failed; retry scheduled, HTTP',
      typeof status === 'number' ? status : 0);
    return false;
  }
}

export async function unregisterCurrentDevice(): Promise<void> {
  const settled = registrationRetry.stop();
  tokenRetry.stop();
  if (!currentExtension) return;
  const extension = currentExtension;
  currentExtension = '';
  await settled;
  try {
    const deviceUuid = await getDeviceUuid();
    const gateway = await resolvePushGateway(CONFIG.sipDomain, extension);
    const body: Record<string, string> = {
      extension: gateway?.assignment.extension || extension,
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
