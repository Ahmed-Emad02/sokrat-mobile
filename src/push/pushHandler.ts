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
  deleteToken,
  onTokenRefresh,
  requestPermission,
} from '@react-native-firebase/messaging';
import { CONFIG, hydrateAppVersion } from '../config';
import { callDisplayName, providerCallerName } from '../calls/callerName';
import { getDeviceUuid, UUID_PATTERN } from '../storage/deviceId';
import type { SavedAccount } from '../storage/store';
import {
  getOrLoadGatewaySession,
  getPersistedGatewayRecord,
  getActiveGatewaySession,
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

export type ChatPushPayload = {
  type: 'chat-message';
  conversationId: string;
  messageId: string;
  senderExtension: string;
  extension: string;
  preview?: string;
  timestamp?: string;
};

type ChatPushHandler = (payload: ChatPushPayload) => void;

/** Normalize a raw FCM data payload into ChatPushPayload, or null if not chat. */
export function normalizeChatPayload(data: Record<string, string | undefined>): ChatPushPayload | null {
  if (data.type !== 'chat-message') return null;
  if (!data.conversationId || !data.messageId || !data.senderExtension || !data.extension) return null;
  return {
    type: 'chat-message',
    conversationId: data.conversationId,
    messageId: data.messageId,
    senderExtension: data.senderExtension,
    extension: data.extension,
    preview: data.preview,
    timestamp: data.timestamp,
  };
}

type RawPushPayload = Omit<Partial<PushPayload>, 'msg' | 'type'> & { msg?: string; type?: string };
type PushHandler = (payload: PushPayload) => void;
type CancelHandler = (payload: CancelPayload) => void;

const PENDING_CALLS_KEY = '@sokrat/pending-incoming-calls';
const PUSH_APP_VERSION_KEY = '@sokrat/push-app-version';
const MAX_PENDING_AGE_MS = 90_000;

let onIncoming: PushHandler | null = null;
let onCancel: CancelHandler | null = null;
let onChatMessage: ChatPushHandler | null = null;
let currentExtension = '';
let voipTokenCache: string | null = null;
let fcmTokenCache: string | null = null;
let lastFcmTokenAt = 0;
let lastFcmError = '';
let lastPushRegisteredAt = 0;
let lastPushRegisterError = '';
let pendingAndroidPayload: PushPayload | null = null;
let lastDeliveredCallId = '';
let lastWakeTimestamp = 0;
const registrationRetry = createRegistrationRetry();
const tokenRetry = createRegistrationRetry();
let tokenListenersInitialized = false;
let repairInFlight = false;
let repairQueued = false;

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
      lastFcmTokenAt = Date.now();
      lastFcmError = '';
      registerCachedToken();
      return true;
    } catch (error) {
      lastFcmError = error instanceof Error ? error.message : String(error);
      console.warn('[push] FCM token unavailable; retry scheduled');
      return false;
    }
  });
}

/**
 * Refresh the currently cached token on startup/foreground without invalidating
 * it. App-version changes are recorded for diagnostics only; deleting a token
 * is reserved for the explicit repair action so no healthy user token is lost.
 */
async function refreshAndroidTokenForAppVersion() {
  if (Platform.OS !== 'android' || !currentExtension) return;
  const version = String(CONFIG.appVersion || '');
  try {
    await AsyncStorage.setItem(PUSH_APP_VERSION_KEY, version);
    refreshAndroidToken();
  } catch {
    console.warn('[push] app-version token check failed; retry on next foreground');
  }
}

/**
 * Explicit repair path for settings/operator use. This is the only operation
 * that should delete a healthy token outside an app-version change.
 */
/** Sanitized diagnostics only; never expose the raw FCM token. */
export function getPushDiagnostics(): {
  fcmTokenPresent: boolean;
  lastFcmTokenAt: number;
  lastFcmError: string;
  lastPushRegisteredAt: number;
  lastPushRegisterError: string;
} {
  return {
    fcmTokenPresent: Boolean(fcmTokenCache),
    lastFcmTokenAt,
    lastFcmError,
    lastPushRegisteredAt,
    lastPushRegisterError,
  };
}

function queueTokenConflictRepair(): void {
  if (repairInFlight || repairQueued) return;
  repairQueued = true;
  setTimeout(() => {
    repairQueued = false;
    void repairPushRegistration();
  }, 0);
}

export async function repairPushRegistration(): Promise<boolean> {
  if (Platform.OS !== 'android' || !currentExtension || repairInFlight) return false;
  repairInFlight = true;
  const extension = currentExtension;
  const host = CONFIG.sipDomain;
  try {
    // Repair is an explicit one-shot operation. Drain normal registration
    // retries first so deleteToken/getToken/register cannot race a foreground or
    // token-refresh registration.
    await registrationRetry.stop();
    await tokenRetry.stop();
    await deleteToken(getMessaging());
    const token = await getToken(getMessaging());
    if (currentExtension !== extension || CONFIG.sipDomain !== host) return false;
    const registered = await sendTokenToGateway('android', token, null, extension, host);
    if (!registered) return false;
    fcmTokenCache = token;
    await AsyncStorage.setItem(PUSH_APP_VERSION_KEY, String(CONFIG.appVersion || ''));
    return true;
  } catch {
    console.warn('[push] push registration repair failed');
    return false;
  } finally {
    repairInFlight = false;
  }
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
    callerName: providerCallerName(data.callerId || '', data.callerName),
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
  const { StorageService } = require('../storage/store');
  const storedAccount = await StorageService.getAccount();
  if (!storedAccount) return true;
  const payloadExtension = typeof rawData.extension === 'string' ? rawData.extension.trim() : '';
  if (payloadExtension && payloadExtension !== storedAccount.extension) {
    console.warn('[push] heartbeat for stale extension ignored');
    return true;
  }
  const wakeTimestamp = Number(rawData.timestamp) || 0;
  if (wakeTimestamp && wakeTimestamp === lastWakeTimestamp) return true;
  require('../calls/connectionService').startConnectionService();
  // Never ACK a wake before SIP is registered. The gateway treats an ACK as
  // proof the device is awake and suppresses the next wake for 180 seconds.
  const sipReady = await bootstrapHeadlessSip(storedAccount, 'keepalive');
  if (!sipReady) {
    console.warn('[push] heartbeat ACK deferred: SIP is not registered');
    return true;
  }
  try {
    const acknowledged = await sendGatewayHeartbeat(
      storedAccount.serverHost,
      storedAccount.extension,
      'wake',
    );
    if (!acknowledged) {
      console.warn('[push] heartbeat ACK skipped: no gateway session');
      return true;
    }
    if (wakeTimestamp) {
      lastWakeTimestamp = wakeTimestamp;
      console.log(`[push] heartbeat ACK sent timestamp=${wakeTimestamp}`);
    }
  } catch (heartbeatError) {
    console.warn('[push] heartbeat ACK failed:', heartbeatError);
  }
  return true;
}

async function bootstrapHeadlessSip(storedAccount: SavedAccount, label: string): Promise<boolean> {
  try {
    const { getSharedJsSipService } = require('../sip/JsSipService');
    const headlessSip = getSharedJsSipService();
    if (headlessSip.isRegistered()) return true;
    // Hydrate the approved gateway assignment first: a gateway-enrolled device
    // must wake through the ticket/relay path, never the direct PBX socket.
    await getOrLoadGatewaySession(storedAccount.serverHost, storedAccount.extension);
    if (!headlessSip.isConnectedOrConnecting()) {
      console.log(`[push][${label}] headless bootstrapping SIP for ext=${storedAccount.extension}`);
      await headlessSip.connect(
        storedAccount.extension,
        storedAccount.password,
        storedAccount.serverHost,
        storedAccount.useTls,
      );
    }
    return headlessSip.isRegistered();
  } catch (bootstrapErr) {
    console.error('[push] headless SIP bootstrap error:', bootstrapErr);
    return false;
  }
}

if (Platform.OS === 'android') {
  try {
    const messaging = getMessaging();
    setBackgroundMessageHandler(messaging, async (remoteMessage) => {
      const rawData = (remoteMessage?.data || {}) as RawPushPayload;
      if (await handleWake(rawData)) return;
      // Chat message — never triggers SIP, never auto-starts calls
      const chatPayload = normalizeChatPayload(rawData as Record<string, string | undefined>);
      if (chatPayload) {
        console.log(`[push][chat] background chat-message convId=${chatPayload.conversationId}`);
        if (onChatMessage) onChatMessage(chatPayload);
        return;
      }
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

export async function initPush(onIncomingCall: PushHandler, onCancelCall?: CancelHandler) {
  await hydrateAppVersion();
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
        // Chat message — never triggers SIP
        const chatPayload = normalizeChatPayload(rawData as Record<string, string | undefined>);
        if (chatPayload) {
          console.log(`[push][chat] foreground chat-message convId=${chatPayload.conversationId}`);
          if (onChatMessage) onChatMessage(chatPayload);
          return;
        }
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
          void refreshAndroidTokenForAppVersion();
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

/** Register a listener for incoming chat push notifications. */
export function bindChatPushHandler(handler: ChatPushHandler | null): void {
  onChatMessage = handler;
}

export function bindExtension(extension: string) {
  registrationRetry.stop();
  tokenRetry.stop();
  currentExtension = extension;
  registerCachedToken();
  void refreshAndroidTokenForAppVersion();
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
  // Prefer the approved active session. After local fallback the active
  // session has the local deviceId; probing the cloud record first would hit
  // "Gateway account changed" and incorrectly skip local token registration.
  const active = getActiveGatewaySession(host, extension);
  if (active) return active;
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
      lastPushRegisteredAt = Date.now();
      lastPushRegisterError = '';
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
        lastPushRegisterError = `HTTP ${response.status}`;
        console.warn('[push] gateway registration failed; retry scheduled, HTTP', response.status);
        return false;
      }
    } finally {
      clearTimeout(timer);
    }
    lastPushRegisteredAt = Date.now();
    lastPushRegisterError = '';
    console.log('[push] token registration confirmed');
    return true;
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    lastPushRegisterError = `HTTP ${typeof status === 'number' ? status : 0}`;
    console.warn('[push] token registration failed; retry scheduled, HTTP',
      typeof status === 'number' ? status : 0);
    if (status === 409) queueTokenConflictRepair();
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
